// ═══════════════════════════════════════════════════════════════════════
//  src/live/risk_engine/index.js — LIVE risk controls (extends simulation risk)
// ═══════════════════════════════════════════════════════════════════════
//  Enforces real-money limits on top of the Phase 1 preTradeRisk pipeline:
//   - Daily realized-loss stop
//   - Daily reject count stop
//   - Max concurrent open orders
//   - Max position per market
//   - Max order qty / notional
//   - Slippage tolerance (vs expected price)
//   - Kill-switch integration
//
//  Completely separate from `src/engine/risk.js` to preserve that
//  module's purity / determinism. This file is side-effectful (tracks
//  running totals across the trading day) but exposes pure helper
//  functions for testability.
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG, isKillSwitchActive } from "../config/index.js";
import { getLogger } from "../logging/index.js";

function ymd(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

export class LiveRiskEngine {
  constructor(cfg = LIVE_CONFIG, logger = null) {
    this.cfg = cfg;
    this.log = logger || getLogger(cfg);
    this.state = {
      day: ymd(),
      realizedPnlToday: 0,
      rejectsToday: 0,
      openOrderIds: new Set(),
      halted: false,
      haltReason: null,
    };
  }

  // ── Daily reset ──
  _maybeRollDay() {
    const today = ymd();
    if (this.state.day !== today) {
      this.log.info("New trading day", { prev: this.state.day, today });
      this.state.day = today;
      this.state.realizedPnlToday = 0;
      this.state.rejectsToday = 0;
      // Don't clear openOrderIds — they persist across days
      this.state.halted = false;
      this.state.haltReason = null;
    }
  }

  /** Called after each fill or realized-PnL event. */
  recordRealizedPnl(pnl) {
    this._maybeRollDay();
    this.state.realizedPnlToday += pnl;
    if (this.state.realizedPnlToday <= -this.cfg.risk.maxDailyLoss) {
      this._halt(`daily_loss_limit: $${this.state.realizedPnlToday.toFixed(2)} <= -$${this.cfg.risk.maxDailyLoss}`);
    }
  }

  /** Called when an order or risk check fails. */
  recordReject(reason = "unknown") {
    this._maybeRollDay();
    this.state.rejectsToday++;
    this.log.warn("Risk reject", { reason, rejectsToday: this.state.rejectsToday });
    if (this.state.rejectsToday >= this.cfg.risk.maxDailyRejects) {
      this._halt(`daily_reject_limit: ${this.state.rejectsToday}`);
    }
  }

  /** Register an order as open. */
  trackOrder(orderId) {
    if (orderId) this.state.openOrderIds.add(orderId);
  }

  /** Remove an order from the open set (filled, cancelled, rejected). */
  untrackOrder(orderId) {
    if (orderId) this.state.openOrderIds.delete(orderId);
  }

  /** Sync against external truth (e.g. getOpenOrders()). */
  syncOpenOrders(openIds) {
    this.state.openOrderIds = new Set(openIds);
  }

  _halt(reason) {
    if (this.state.halted) return;
    this.state.halted = true;
    this.state.haltReason = reason;
    this.log.error("Trading halted", { reason });
  }

  isHalted() {
    this._maybeRollDay();
    return this.state.halted || isKillSwitchActive(this.cfg);
  }

  /**
   * Pre-trade check for a live order. Returns {ok, reason, adjustedSize}.
   * Runs BEFORE the simulation-side preTradeRisk — this is the outer gate.
   *
   * @param {Object} order
   *   @param {string} order.tokenId
   *   @param {"BUY"|"SELL"} order.side
   *   @param {number} order.price
   *   @param {number} order.size
   *   @param {number} [order.expectedPrice]  what the signal thought the price was
   *   @param {number} [order.currentPosition] contracts currently held in this market
   *   @param {Object} [order.book]             orderbook snapshot
   */
  checkOrder(order) {
    this._maybeRollDay();
    const r = this.cfg.risk;

    // Hard halt
    if (this.isHalted()) {
      return { ok: false, reason: `halted: ${this.state.haltReason || "kill_switch"}` };
    }

    let adjSize = order.size;

    // Max qty
    if (adjSize > r.maxOrderQty) {
      this.log.warn("Order size exceeds maxOrderQty; clamping", { requested: adjSize, max: r.maxOrderQty });
      adjSize = r.maxOrderQty;
    }

    // Max notional
    const notional = adjSize * order.price;
    if (notional > r.maxOrderNotional) {
      adjSize = Math.floor(r.maxOrderNotional / order.price);
      if (adjSize <= 0) {
        return { ok: false, reason: `notional_too_small at price ${order.price}` };
      }
    }

    // Max position per market
    if (typeof order.currentPosition === "number") {
      const projected = order.currentPosition + (order.side === "BUY" ? adjSize : -adjSize);
      if (Math.abs(projected) > r.maxPositionPerMarket) {
        const allowed = Math.max(0, r.maxPositionPerMarket - Math.abs(order.currentPosition));
        if (allowed <= 0) return { ok: false, reason: `position_cap:${r.maxPositionPerMarket}` };
        adjSize = allowed;
      }
    }

    // Max concurrent orders
    if (this.state.openOrderIds.size >= r.maxConcurrentOrders) {
      return { ok: false, reason: `concurrent_orders_cap:${r.maxConcurrentOrders}` };
    }

    // Slippage tolerance
    if (typeof order.expectedPrice === "number" && order.expectedPrice > 0) {
      const slipBps = Math.abs(order.price - order.expectedPrice) / order.expectedPrice * 10000;
      if (slipBps > r.maxSlippageBps) {
        return { ok: false, reason: `slippage:${slipBps.toFixed(1)}bps > ${r.maxSlippageBps}` };
      }
    }

    // Liquidity (book depth)
    if (order.book) {
      const depth = order.side === "BUY" ? order.book.askDepth : order.book.bidDepth;
      if (depth < this.cfg.filters.minDepth) {
        return { ok: false, reason: `insufficient_depth:${depth} < ${this.cfg.filters.minDepth}` };
      }
    }

    if (adjSize < 1) return { ok: false, reason: "size_rounded_to_zero" };

    return { ok: true, adjustedSize: adjSize };
  }

  /** Emergency stop: halt + signal to caller that all orders should be cancelled. */
  emergencyStop(reason = "manual") {
    this._halt(`emergency_stop:${reason}`);
  }

  snapshot() {
    this._maybeRollDay();
    return {
      day: this.state.day,
      realizedPnlToday: +this.state.realizedPnlToday.toFixed(2),
      rejectsToday: this.state.rejectsToday,
      openOrderCount: this.state.openOrderIds.size,
      halted: this.state.halted,
      haltReason: this.state.haltReason,
      killSwitch: isKillSwitchActive(this.cfg),
    };
  }
}
