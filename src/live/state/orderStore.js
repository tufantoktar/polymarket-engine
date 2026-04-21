// ═══════════════════════════════════════════════════════════════════════
//  src/live/state/orderStore.js — in-memory order registry
// ═══════════════════════════════════════════════════════════════════════
//  Single source of truth for live orders. Wraps the state machine so
//  every transition is persisted atomically. Provides multiple indexes
//  (orderId, signalKey, externalOrderId) to avoid O(n) scans at the
//  call site.
//
//  Replaces the ad-hoc `Map<orderId, entry>` that lived inside
//  LiveExecutionEngine in V5.3. That old map mixed domain concerns
//  (fills, status strings, cancellation) with storage concerns.
// ═══════════════════════════════════════════════════════════════════════

import {
  ORDER_STATES,
  createOrderState,
  transitionOrder,
  isTerminalState,
} from "./orderStateMachine.js";

export class OrderStore {
  constructor() {
    this._byOrderId = new Map();         // orderId → order
    this._bySignalKey = new Map();       // signalKey → orderId (latest)
    this._byExternalId = new Map();      // externalOrderId → orderId
    // Monotonic counter for internal order IDs
    this._seq = 0;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Internal ID generation — deterministic, unique, human-scannable
  // ═══════════════════════════════════════════════════════════════════
  _nextOrderId(tokenId = "unk") {
    this._seq++;
    return `ord_${tokenId.slice(0, 8)}_${Date.now()}_${this._seq}`;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  create — registers a new order in IDLE state
  //
  //  Rejects duplicates: if the same signalKey already exists AND is
  //  not in a terminal state, the existing order is returned with
  //  { duplicate: true } so the caller can decide what to do.
  // ═══════════════════════════════════════════════════════════════════
  create(orderData) {
    const { signalKey, tokenId } = orderData;
    if (!signalKey) throw new Error("OrderStore.create: signalKey required");
    if (!tokenId) throw new Error("OrderStore.create: tokenId required");

    // Duplicate detection: only active duplicates block
    const existingId = this._bySignalKey.get(signalKey);
    if (existingId) {
      const existing = this._byOrderId.get(existingId);
      if (existing && !isTerminalState(existing.state)) {
        return { duplicate: true, order: existing };
      }
    }

    const orderId = orderData.orderId || this._nextOrderId(tokenId);
    const order = createOrderState({ ...orderData, orderId });
    this._byOrderId.set(orderId, order);
    this._bySignalKey.set(signalKey, orderId);
    return { duplicate: false, order };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Lookup helpers
  // ═══════════════════════════════════════════════════════════════════
  get(orderId) { return this._byOrderId.get(orderId) || null; }

  getBySignalKey(signalKey) {
    const id = this._bySignalKey.get(signalKey);
    return id ? this._byOrderId.get(id) || null : null;
  }

  hasSignalKey(signalKey) {
    const order = this.getBySignalKey(signalKey);
    return !!order && !isTerminalState(order.state);
  }

  findByExternalOrderId(externalOrderId) {
    const id = this._byExternalId.get(externalOrderId);
    return id ? this._byOrderId.get(id) || null : null;
  }

  listAll() {
    return [...this._byOrderId.values()];
  }

  /** Orders not in a terminal state. Sorted by createdAt ascending. */
  listOpenOrders() {
    const out = [];
    for (const o of this._byOrderId.values()) {
      if (!isTerminalState(o.state)) out.push(o);
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Atomic state transitions — the ONLY way to mutate order state
  // ═══════════════════════════════════════════════════════════════════
  transition(orderId, nextState, patch = {}) {
    const current = this._byOrderId.get(orderId);
    if (!current) return { ok: false, error: `order_not_found:${orderId}`, order: null };

    const result = transitionOrder(current, nextState, patch);
    if (!result.ok) return result;

    this._byOrderId.set(orderId, result.order);

    // If the external ID was set via patch, register the reverse index
    if (patch.externalOrderId && patch.externalOrderId !== current.externalOrderId) {
      this._byExternalId.set(patch.externalOrderId, orderId);
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  upsertExternalMapping — wire an exchange-assigned id to our order
  // ═══════════════════════════════════════════════════════════════════
  upsertExternalMapping(orderId, externalOrderId) {
    const order = this._byOrderId.get(orderId);
    if (!order) return { ok: false, error: `order_not_found:${orderId}` };
    if (!externalOrderId) return { ok: false, error: "empty_externalOrderId" };

    const updated = { ...order, externalOrderId, updatedAt: Date.now() };
    this._byOrderId.set(orderId, updated);
    this._byExternalId.set(externalOrderId, orderId);
    return { ok: true, order: updated };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  snapshot — JSON-serializable view for logs / debug
  // ═══════════════════════════════════════════════════════════════════
  snapshot() {
    const all = this.listAll();
    const byState = {};
    for (const o of all) {
      byState[o.state] = (byState[o.state] || 0) + 1;
    }
    return {
      total: all.length,
      open: this.listOpenOrders().length,
      byState,
    };
  }
}
