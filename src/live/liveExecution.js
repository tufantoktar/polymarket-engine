// ═══════════════════════════════════════════════════════════════════════
//  src/live/liveExecution.js — live order execution engine
// ═══════════════════════════════════════════════════════════════════════
//  High-level execution surface used by the event loop.
//
//   - placeOrder()      orchestrates: liveRisk → adjust → client.placeOrder
//                       → track → log
//   - cancelOrder()     + untrack
//   - getOpenOrders()   + sync with liveRisk state
//   - syncPositions()   pull on-chain balances into a local map
//
//  Wraps PolymarketClient, LiveRiskEngine, Wallet — so the event loop
//  never deals with any of them individually.
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG } from "./config.js";
import { getLogger } from "./logger.js";
import { PolymarketClient } from "./polymarketClient.js";
import { Wallet } from "./wallet.js";
import { LiveRiskEngine } from "./liveRisk.js";

export class LiveExecutionEngine {
  /**
   * @param {Object} deps  Optional DI for tests; production leaves blank.
   */
  constructor(deps = {}) {
    this.cfg = deps.cfg || LIVE_CONFIG;
    this.log = deps.logger || getLogger(this.cfg);
    this.client = deps.client || new PolymarketClient(this.cfg, this.log);
    this.wallet = deps.wallet || new Wallet(this.cfg, this.log);
    this.risk   = deps.risk   || new LiveRiskEngine(this.cfg, this.log);
    // Local positions cache: tokenId → contracts held
    this.positions = new Map();
    // Local tracking: orderId → { tokenId, side, price, size, placedAt, status }
    this.orderRegistry = new Map();
  }

  async init() {
    const snap = await this.wallet.snapshot();
    this.log.info("Execution engine ready", {
      mode: this.cfg.mode,
      wallet: snap.address,
      usdc: snap.usdc,
      approvals: snap.approvals,
      paper: snap.paper,
    });
    return snap;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  placeOrder — outer entry point for signal → execution
  // ═══════════════════════════════════════════════════════════════════
  async placeOrder(order) {
    // 1. Fetch latest book for the token (for slippage + depth check)
    let book = null;
    try {
      book = await this.client.getOrderbook(order.tokenId);
    } catch (e) {
      this.log.errorEvent("placeOrder:getOrderbook", e, { tokenId: order.tokenId });
    }

    // 2. Risk check
    const currentPosition = this.positions.get(order.tokenId) || 0;
    const riskCheck = this.risk.checkOrder({
      ...order,
      currentPosition,
      book,
    });

    this.log.decision("placeOrder", {
      order: { ...order, currentPosition },
      risk: riskCheck,
      book: book ? { midPrice: book.midPrice, spread: book.spread, bidDepth: book.bidDepth, askDepth: book.askDepth } : null,
    });

    if (!riskCheck.ok) {
      this.risk.recordReject(riskCheck.reason);
      return { success: false, reason: riskCheck.reason };
    }

    const placed = { ...order, size: riskCheck.adjustedSize };

    // 3. Submit to Polymarket (or paper sim)
    let resp;
    try {
      resp = await this.client.placeOrder(placed);
    } catch (e) {
      this.log.errorEvent("placeOrder:client", e, { order: placed });
      this.risk.recordReject("api_error");
      return { success: false, reason: `api_error:${e.message}` };
    }

    // 4. Track
    const orderId = resp.orderID || resp.id || null;
    if (orderId) {
      this.orderRegistry.set(orderId, {
        ...placed,
        orderId,
        placedAt: Date.now(),
        status: resp.status || "unknown",
      });
      this.risk.trackOrder(orderId);
    }

    return { success: true, orderId, response: resp };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  cancelOrder
  // ═══════════════════════════════════════════════════════════════════
  async cancelOrder(orderId) {
    try {
      const resp = await this.client.cancelOrder(orderId);
      this.risk.untrackOrder(orderId);
      const entry = this.orderRegistry.get(orderId);
      if (entry) entry.status = "cancelled";
      this.log.decision("cancelOrder", { orderId, response: resp });
      return { success: true, response: resp };
    } catch (e) {
      this.log.errorEvent("cancelOrder", e, { orderId });
      return { success: false, reason: e.message };
    }
  }

  /** Cancel everything (kill-switch / emergency stop). */
  async cancelAllOrders() {
    try {
      const resp = await this.client.cancelAllOrders();
      this.risk.syncOpenOrders([]);
      for (const [id, entry] of this.orderRegistry) {
        if (entry.status === "resting" || entry.status === "unknown") {
          entry.status = "cancelled";
        }
      }
      this.log.decision("cancelAllOrders", { response: resp });
      return { success: true, response: resp };
    } catch (e) {
      this.log.errorEvent("cancelAllOrders", e);
      return { success: false, reason: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  getOpenOrders + sync
  // ═══════════════════════════════════════════════════════════════════
  async getOpenOrders() {
    if (this.cfg.mode === "paper") {
      // Return tracked orders that aren't cancelled/filled
      return [...this.orderRegistry.values()].filter(o =>
        o.status === "resting" || o.status === "unknown"
      );
    }
    try {
      const orders = await this.client.getOpenOrders();
      this.risk.syncOpenOrders(orders.map(o => o.id || o.orderID));
      return orders;
    } catch (e) {
      this.log.errorEvent("getOpenOrders", e);
      return [];
    }
  }

  /** Poll status of a specific order and update local registry. */
  async refreshOrderStatus(orderId) {
    try {
      const s = await this.client.getOrderStatus(orderId);
      const entry = this.orderRegistry.get(orderId);
      if (entry && s) {
        entry.status = s.status || entry.status;
      }
      // If terminal, untrack
      if (s && ["filled", "cancelled", "failed", "expired"].includes(s.status)) {
        this.risk.untrackOrder(orderId);
      }
      return s;
    } catch (e) {
      this.log.errorEvent("refreshOrderStatus", e, { orderId });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  syncPositions — pull on-chain balances
  // ═══════════════════════════════════════════════════════════════════
  async syncPositions(tokenIds = []) {
    if (this.cfg.mode === "paper") {
      // Positions are simulated locally; no on-chain read needed.
      return Object.fromEntries(this.positions);
    }
    for (const tid of tokenIds) {
      try {
        const qty = await this.wallet.getPositionBalance(tid);
        this.positions.set(tid, qty);
      } catch (e) {
        this.log.errorEvent("syncPositions", e, { tokenId: tid });
      }
    }
    return Object.fromEntries(this.positions);
  }

  /** Manual position update (after fills observed in paper mode). */
  updatePosition(tokenId, deltaQty) {
    const cur = this.positions.get(tokenId) || 0;
    this.positions.set(tokenId, cur + deltaQty);
  }

  /** Expire / cancel orders older than the config timeout. */
  async cancelStaleOrders() {
    const cutoff = Date.now() - this.cfg.execution.orderTimeoutMs;
    const stale = [];
    for (const [id, entry] of this.orderRegistry) {
      if ((entry.status === "resting" || entry.status === "unknown") && entry.placedAt < cutoff) {
        stale.push(id);
      }
    }
    if (stale.length === 0) return [];
    this.log.info("Cancelling stale orders", { count: stale.length, cutoffMs: this.cfg.execution.orderTimeoutMs });
    const results = [];
    for (const id of stale) {
      results.push(await this.cancelOrder(id));
    }
    return results;
  }

  snapshot() {
    return {
      mode: this.cfg.mode,
      positionCount: this.positions.size,
      trackedOrders: this.orderRegistry.size,
      risk: this.risk.snapshot(),
    };
  }
}
