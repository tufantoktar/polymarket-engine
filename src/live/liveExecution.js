// ═══════════════════════════════════════════════════════════════════════
//  src/live/liveExecution.js — live order execution engine (V5.4)
// ═══════════════════════════════════════════════════════════════════════
//  High-level execution surface used by the event loop.
//
//  V5.4 refactor:
//   - Order lifecycle moved to OrderStore + orderStateMachine
//   - Position state moved to PositionStore
//   - Idempotency enforced via SignalDeduper
//   - All state transitions go through explicit FSM (no silent mutation)
//
//  Public surface preserved:
//   - init()
//   - placeOrder()         (now rejects duplicate signalKeys)
//   - cancelOrder()
//   - cancelAllOrders()
//   - getOpenOrders()
//   - refreshOrderStatus()
//   - syncPositions()
//   - updatePosition()     (kept for paper-mode fill simulation)
//   - cancelStaleOrders()
//   - snapshot()
//
//   New:
//   - applyFill()          (observed fill → FSM advance + PositionStore.applyFill)
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG } from "./config.js";
import { getLogger } from "./logger.js";
import { PolymarketClient } from "./polymarketClient.js";
import { Wallet } from "./wallet.js";
import { LiveRiskEngine } from "./liveRisk.js";

import { OrderStore } from "./state/orderStore.js";
import { PositionStore } from "./state/positionStore.js";
import { SignalDeduper, buildSignalKey } from "./state/signalDeduper.js";
import {
  ORDER_STATES,
  isTerminalState,
} from "./state/orderStateMachine.js";

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

    // V5.4 state modules
    this.orders = deps.orders || new OrderStore();
    this.positions = deps.positions || new PositionStore();
    this.deduper = deps.deduper || new SignalDeduper({
      ttlMs: this.cfg.execution?.orderTimeoutMs ? this.cfg.execution.orderTimeoutMs * 3 : undefined,
    });
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
  //
  //  Flow (V5.4):
  //    1. build signalKey + check deduper / store for duplicates
  //    2. fetch orderbook for risk check
  //    3. run risk engine (outer gate)
  //    4. create internal order record (state = IDLE)
  //    5. transition IDLE → SIGNAL_DETECTED
  //    6. submit to exchange
  //    7a. on success: SIGNAL_DETECTED → ORDER_PLACED
  //    7b. on failure: SIGNAL_DETECTED → FAILED
  // ═══════════════════════════════════════════════════════════════════
  async placeOrder(order) {
    // ─── 1. Idempotency key ─────────────────────────────────────────
    const signalKey = order.signalKey || buildSignalKey({
      source: order.source || order.strategy || "manual",
      marketId: order.marketId,
      tokenId: order.tokenId,
      side: order.side,
      action: order.orderType || order.urg || "default",
      timestamp: order.signalTimestamp || Date.now(),
    });

    if (this.deduper.has(signalKey)) {
      this.log.decision("placeOrder:duplicate_signal", { signalKey, reason: "dedupe_cache_hit" });
      return { success: false, reason: "duplicate_signal", signalKey };
    }
    if (this.orders.hasSignalKey(signalKey)) {
      const existing = this.orders.getBySignalKey(signalKey);
      this.log.decision("placeOrder:duplicate_order", { signalKey, orderId: existing?.orderId, state: existing?.state });
      return { success: false, reason: "duplicate_order", signalKey, orderId: existing?.orderId };
    }

    // ─── 2. Orderbook snapshot ──────────────────────────────────────
    let book = null;
    try {
      book = await this.client.getOrderbook(order.tokenId);
    } catch (e) {
      this.log.errorEvent("placeOrder:getOrderbook", e, { tokenId: order.tokenId });
    }

    // ─── 3. Risk check ──────────────────────────────────────────────
    const currentPosition = this.positions.get(order.tokenId).qty;
    const riskCheck = this.risk.checkOrder({ ...order, currentPosition, book });

    this.log.decision("placeOrder:risk", {
      signalKey,
      order: { tokenId: order.tokenId, side: order.side, size: order.size, price: order.price, currentPosition },
      risk: riskCheck,
      book: book ? { midPrice: book.midPrice, spread: book.spread, bidDepth: book.bidDepth, askDepth: book.askDepth } : null,
    });

    if (!riskCheck.ok) {
      this.risk.recordReject(riskCheck.reason);
      this.deduper.mark(signalKey, { stage: "risk_reject", reason: riskCheck.reason });
      return { success: false, reason: riskCheck.reason, signalKey };
    }

    const adjustedSize = riskCheck.adjustedSize ?? order.size;
    const placed = { ...order, size: adjustedSize };

    // ─── 4. Register in store (state = IDLE) ────────────────────────
    const { duplicate, order: newOrder } = this.orders.create({
      signalKey,
      marketId: order.marketId || null,
      tokenId: order.tokenId,
      side: order.side,
      size: adjustedSize,
      price: order.price ?? null,
      meta: {
        source: order.source || null,
        strategy: order.strategy || null,
        urgency: order.orderType || order.urg || null,
        expectedPrice: order.expectedPrice ?? null,
      },
    });
    if (duplicate) {
      this.log.decision("placeOrder:store_duplicate", { signalKey, orderId: newOrder.orderId, state: newOrder.state });
      return { success: false, reason: "duplicate_order_in_store", signalKey, orderId: newOrder.orderId };
    }
    const internalId = newOrder.orderId;

    // ─── 5. Transition IDLE → SIGNAL_DETECTED ───────────────────────
    let tr = this.orders.transition(internalId, ORDER_STATES.SIGNAL_DETECTED);
    if (!tr.ok) {
      this.log.errorEvent("placeOrder:transition", new Error(tr.error), { orderId: internalId, from: "IDLE", to: "SIGNAL_DETECTED" });
      return { success: false, reason: `fsm:${tr.error}`, orderId: internalId };
    }
    this._logTransition(tr.order, "IDLE", ORDER_STATES.SIGNAL_DETECTED);

    // Mark dedupe cache so concurrent ticks don't race us
    this.deduper.mark(signalKey, { stage: "submitting", orderId: internalId });

    // ─── 6. Submit to exchange (or paper sim) ───────────────────────
    let resp;
    try {
      resp = await this.client.placeOrder(placed);
    } catch (e) {
      this.log.errorEvent("placeOrder:client", e, { orderId: internalId, order: placed });
      this.risk.recordReject("api_error");
      const ftr = this.orders.transition(internalId, ORDER_STATES.FAILED, { reason: `api_error:${e.message}` });
      if (ftr.ok) this._logTransition(ftr.order, ORDER_STATES.SIGNAL_DETECTED, ORDER_STATES.FAILED);
      return { success: false, reason: `api_error:${e.message}`, orderId: internalId, signalKey };
    }

    const externalOrderId = resp?.orderID || resp?.id || null;

    // ─── 7. Transition SIGNAL_DETECTED → ORDER_PLACED ───────────────
    tr = this.orders.transition(internalId, ORDER_STATES.ORDER_PLACED, {
      externalOrderId,
      reason: resp?.status || null,
    });
    if (!tr.ok) {
      // State machine rejected — shouldn't happen, but if it does,
      // we'd have an order on the exchange with no local record.
      // Best effort: log loudly and cancel remotely.
      this.log.errorEvent("placeOrder:post_submit_transition_failed", new Error(tr.error), { orderId: internalId, externalOrderId });
      if (externalOrderId) {
        try { await this.client.cancelOrder(externalOrderId); } catch { /* ignore */ }
      }
      return { success: false, reason: `fsm:${tr.error}`, orderId: internalId, externalOrderId, signalKey };
    }
    this._logTransition(tr.order, ORDER_STATES.SIGNAL_DETECTED, ORDER_STATES.ORDER_PLACED);
    this.risk.trackOrder(externalOrderId || internalId);

    return {
      success: true,
      orderId: internalId,
      externalOrderId,
      signalKey,
      response: resp,
      order: tr.order,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  applyFill — called when a fill event is observed
  //
  //  Drives two concerns:
  //    1. Order FSM advance (ORDER_PLACED / PARTIAL_FILL → PARTIAL_FILL / FILLED)
  //    2. Position update via PositionStore.applyFill
  //
  //  The caller provides the internal orderId.
  // ═══════════════════════════════════════════════════════════════════
  applyFill({ orderId, fillSize, fillPrice, timestamp }) {
    const order = this.orders.get(orderId);
    if (!order) {
      this.log.errorEvent("applyFill:order_not_found", new Error("no_order"), { orderId });
      return { ok: false, reason: "order_not_found" };
    }
    if (isTerminalState(order.state)) {
      this.log.warn("applyFill: order already terminal", { orderId, state: order.state });
      return { ok: false, reason: `terminal:${order.state}` };
    }
    if (!(fillSize > 0)) {
      return { ok: false, reason: "invalid_fillSize" };
    }

    const newFilled = Math.min(order.size, order.filledSize + fillSize);
    const fullyFilled = newFilled >= order.size - 1e-9;
    const nextState = fullyFilled ? ORDER_STATES.FILLED : ORDER_STATES.PARTIAL_FILL;

    // Weighted avg fill price on the order record
    const prevNotional = (order.avgFillPrice || 0) * order.filledSize;
    const addedNotional = fillPrice * fillSize;
    const newAvg = newFilled > 0 ? +((prevNotional + addedNotional) / newFilled).toFixed(6) : null;

    const tr = this.orders.transition(orderId, nextState, {
      filledSize: newFilled,
      avgFillPrice: newAvg,
    });
    if (!tr.ok) {
      this.log.errorEvent("applyFill:transition", new Error(tr.error), { orderId, from: order.state, to: nextState });
      return { ok: false, reason: `fsm:${tr.error}` };
    }
    this._logTransition(tr.order, order.state, nextState);

    // Update position store — only from actual fills, never from intent
    const pos = this.positions.applyFill({
      tokenId: order.tokenId,
      side: order.side,
      size: fillSize,
      price: fillPrice,
      orderId,
      externalOrderId: order.externalOrderId,
      timestamp: timestamp || Date.now(),
    });

    if (fullyFilled) {
      this.risk.untrackOrder(order.externalOrderId || orderId);
    }

    this.log.trade("fill", {
      orderId,
      externalOrderId: order.externalOrderId,
      tokenId: order.tokenId,
      side: order.side,
      fillSize,
      fillPrice,
      filledTotal: newFilled,
      parentSize: order.size,
      state: nextState,
      position: { qty: pos.qty, avgEntryPrice: pos.avgEntryPrice, realizedPnl: pos.realizedPnl },
    });

    return { ok: true, order: tr.order, position: pos };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  cancelOrder — accepts either internal or external ID
  // ═══════════════════════════════════════════════════════════════════
  async cancelOrder(idOrExternalId) {
    // Resolve to internal id
    let order = this.orders.get(idOrExternalId) || this.orders.findByExternalOrderId(idOrExternalId);
    if (!order) {
      this.log.warn("cancelOrder: unknown id", { id: idOrExternalId });
      // Still attempt remote cancel in case the store drifted
      try {
        const resp = await this.client.cancelOrder(idOrExternalId);
        return { success: true, response: resp, orphan: true };
      } catch (e) {
        this.log.errorEvent("cancelOrder:orphan", e, { id: idOrExternalId });
        return { success: false, reason: e.message };
      }
    }

    const externalOrderId = order.externalOrderId;
    try {
      const resp = externalOrderId ? await this.client.cancelOrder(externalOrderId) : { success: true, synthetic: true };
      this.risk.untrackOrder(externalOrderId || order.orderId);
      const tr = this.orders.transition(order.orderId, ORDER_STATES.CANCELLED, { reason: "user_cancel" });
      if (tr.ok) this._logTransition(tr.order, order.state, ORDER_STATES.CANCELLED);
      this.log.decision("cancelOrder", { orderId: order.orderId, externalOrderId, response: resp });
      return { success: true, response: resp, orderId: order.orderId };
    } catch (e) {
      this.log.errorEvent("cancelOrder", e, { orderId: order.orderId, externalOrderId });
      return { success: false, reason: e.message, orderId: order.orderId };
    }
  }

  /** Cancel everything (kill-switch / emergency stop). */
  async cancelAllOrders() {
    try {
      const resp = await this.client.cancelAllOrders();
      this.risk.syncOpenOrders([]);
      for (const o of this.orders.listOpenOrders()) {
        const tr = this.orders.transition(o.orderId, ORDER_STATES.CANCELLED, { reason: "cancel_all" });
        if (tr.ok) this._logTransition(tr.order, o.state, ORDER_STATES.CANCELLED);
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
      return this.orders.listOpenOrders();
    }
    try {
      const remote = await this.client.getOpenOrders();
      this.risk.syncOpenOrders(remote.map(o => o.id || o.orderID));
      return remote;
    } catch (e) {
      this.log.errorEvent("getOpenOrders", e);
      return [];
    }
  }

  /** Poll status of a specific order and update local store. */
  async refreshOrderStatus(orderIdOrExternal) {
    const order = this.orders.get(orderIdOrExternal) || this.orders.findByExternalOrderId(orderIdOrExternal);
    const lookupId = order?.externalOrderId || orderIdOrExternal;
    try {
      const s = await this.client.getOrderStatus(lookupId);
      if (!s) return null;

      const statusMap = {
        filled: ORDER_STATES.FILLED,
        cancelled: ORDER_STATES.CANCELLED,
        canceled: ORDER_STATES.CANCELLED,
        failed: ORDER_STATES.FAILED,
        expired: ORDER_STATES.CANCELLED,
      };
      const mapped = statusMap[s.status];

      if (order && mapped && !isTerminalState(order.state) && mapped !== order.state) {
        const tr = this.orders.transition(order.orderId, mapped, { reason: `remote:${s.status}` });
        if (tr.ok) {
          this._logTransition(tr.order, order.state, mapped);
          this.risk.untrackOrder(order.externalOrderId || order.orderId);
        }
      }
      return s;
    } catch (e) {
      this.log.errorEvent("refreshOrderStatus", e, { id: orderIdOrExternal });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Positions
  // ═══════════════════════════════════════════════════════════════════
  async syncPositions(tokenIds = []) {
    if (this.cfg.mode === "paper") {
      return Object.fromEntries(this.positions.list().map(p => [p.tokenId, p]));
    }
    const fetched = [];
    for (const tid of tokenIds) {
      try {
        const qty = await this.wallet.getPositionBalance(tid);
        fetched.push({ tokenId: tid, qty, avgEntryPrice: this.positions.get(tid).avgEntryPrice });
      } catch (e) {
        this.log.errorEvent("syncPositions", e, { tokenId: tid });
      }
    }
    if (fetched.length > 0) {
      // Merge: keep existing records but overwrite qty for fetched tokens
      const existing = this.positions.list().filter(p => !fetched.find(f => f.tokenId === p.tokenId));
      this.positions.restorePositions([...existing, ...fetched]);
    }
    return Object.fromEntries(this.positions.list().map(p => [p.tokenId, p]));
  }

  /**
   * Manual position update — kept for paper-mode simulated fills.
   * Creates a synthetic fill so PnL/avg entry stay consistent.
   */
  updatePosition(tokenId, deltaQty, price = 0.5) {
    if (!tokenId || deltaQty === 0) return;
    const side = deltaQty > 0 ? "BUY" : "SELL";
    this.positions.applyFill({
      tokenId, side, size: Math.abs(deltaQty), price,
      orderId: "manual", externalOrderId: null, timestamp: Date.now(),
    });
  }

  /** Expire / cancel orders older than the config timeout. */
  async cancelStaleOrders() {
    const cutoff = Date.now() - this.cfg.execution.orderTimeoutMs;
    const stale = this.orders.listOpenOrders().filter(o => {
      if (o.state !== ORDER_STATES.ORDER_PLACED && o.state !== ORDER_STATES.PARTIAL_FILL) return false;
      const basis = o.placedAt || o.createdAt;
      return basis < cutoff;
    });
    if (stale.length === 0) return [];
    this.log.info("Cancelling stale orders", { count: stale.length, cutoffMs: this.cfg.execution.orderTimeoutMs });
    const results = [];
    for (const o of stale) {
      results.push(await this.cancelOrder(o.orderId));
    }
    return results;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Internal: structured logging helper
  // ═══════════════════════════════════════════════════════════════════
  _logTransition(order, fromState, toState) {
    if (!order) return;
    this.log.decision("order:transition", {
      orderId: order.orderId,
      externalOrderId: order.externalOrderId,
      signalKey: order.signalKey,
      marketId: order.marketId,
      tokenId: order.tokenId,
      side: order.side,
      from: fromState,
      to: toState,
      filledSize: order.filledSize,
      parentSize: order.size,
      reason: order.reason || null,
      at: order.updatedAt,
    });
  }

  snapshot() {
    return {
      mode: this.cfg.mode,
      orders: this.orders.snapshot(),
      positions: this.positions.snapshot(),
      dedupe: this.deduper.snapshot(),
      risk: this.risk.snapshot(),
    };
  }
}
