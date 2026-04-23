// ═══════════════════════════════════════════════════════════════════════
//  src/live/state/orderStateMachine.js — strict order lifecycle FSM
// ═══════════════════════════════════════════════════════════════════════
//  Pure functions. No I/O, no shared mutable state. All operations
//  return new order objects; callers persist them via the OrderStore.
//
//  Purpose: single source of truth for "what order states exist" and
//  "which transitions are legal". Prevents silent mutation and avoids
//  the ad-hoc status strings ("resting" / "unknown") scattered across
//  liveExecution in V5.3.
// ═══════════════════════════════════════════════════════════════════════

/** Canonical runtime order states. Frozen. */
export const ORDER_STATES = Object.freeze({
  IDLE:            "IDLE",
  SIGNAL_DETECTED: "SIGNAL_DETECTED",
  ORDER_PLACED:    "ORDER_PLACED",
  PARTIAL_FILL:    "PARTIAL_FILL",
  FILLED:          "FILLED",
  CANCELLED:       "CANCELLED",
  FAILED:          "FAILED",
});

/** Terminal states — no transitions out. Frozen. */
const TERMINAL = Object.freeze(new Set([
  ORDER_STATES.FILLED,
  ORDER_STATES.CANCELLED,
  ORDER_STATES.FAILED,
]));

/** Explicit allowed transitions. Anything not listed is rejected. */
const ALLOWED = Object.freeze({
  [ORDER_STATES.IDLE]:            new Set([ORDER_STATES.SIGNAL_DETECTED]),
  [ORDER_STATES.SIGNAL_DETECTED]: new Set([ORDER_STATES.ORDER_PLACED, ORDER_STATES.FAILED]),
  [ORDER_STATES.ORDER_PLACED]:    new Set([ORDER_STATES.PARTIAL_FILL, ORDER_STATES.FILLED, ORDER_STATES.CANCELLED, ORDER_STATES.FAILED]),
  [ORDER_STATES.PARTIAL_FILL]:    new Set([ORDER_STATES.PARTIAL_FILL, ORDER_STATES.FILLED, ORDER_STATES.CANCELLED, ORDER_STATES.FAILED]),
  [ORDER_STATES.FILLED]:          new Set(),
  [ORDER_STATES.CANCELLED]:       new Set(),
  [ORDER_STATES.FAILED]:          new Set(),
});

/** Is this a terminal state? */
export function isTerminalState(state) {
  return TERMINAL.has(state);
}

/** Can we transition from → to? */
export function canTransition(fromState, toState) {
  if (!ALLOWED[fromState]) return false;
  return ALLOWED[fromState].has(toState);
}

/**
 * Create a fresh order state object. Starts in IDLE.
 * The caller should immediately transition it to SIGNAL_DETECTED when
 * a signal is actionable. IDLE is a deliberate pre-emit state so that
 * the lifecycle is fully observable from the very first event.
 */
export function createOrderState({ orderId, signalKey, marketId, tokenId, side, size, price = null, meta = {} }) {
  if (!orderId) throw new Error("createOrderState: orderId required");
  if (!signalKey) throw new Error("createOrderState: signalKey required");
  if (!tokenId) throw new Error("createOrderState: tokenId required");
  if (!["BUY", "SELL"].includes(side)) throw new Error(`createOrderState: invalid side '${side}'`);
  if (!(size > 0)) throw new Error(`createOrderState: size must be > 0, got ${size}`);

  const now = Date.now();
  return {
    // Identity
    orderId,                    // internal ID, our source of truth
    externalOrderId: null,      // set after exchange accepts placement
    signalKey,                  // for idempotency
    // Market
    marketId: marketId || null,
    tokenId,
    side,
    size,                       // requested size
    price,                      // limit price; may be null for market orders
    // Lifecycle
    state: ORDER_STATES.IDLE,
    reason: null,               // populated on FAILED / CANCELLED
    // Fill tracking
    filledSize: 0,
    avgFillPrice: null,
    lastFillAt: null,
    // Timestamps
    createdAt: now,
    updatedAt: now,
    placedAt: null,
    terminalAt: null,
    // History: append-only audit trail
    history: [{ state: ORDER_STATES.IDLE, at: now }],
    // Arbitrary caller metadata (strategy, urgency, etc.)
    meta,
  };
}

/**
 * Transition an order to a new state. Returns a new order object — the
 * caller (OrderStore) is responsible for persistence.
 *
 * @param {Object} order     current order state
 * @param {string} toState   target state
 * @param {Object} [patch]   partial fields to merge
 * @returns {Object}         { ok: true, order } on success
 *                            { ok: false, error, order } on rejection
 *
 * Invalid transitions do NOT throw — they return a structured failure
 * so the caller can log + decide whether to FAIL the order or ignore.
 */
export function transitionOrder(order, toState, patch = {}) {
  if (!order || !order.state) {
    return { ok: false, error: "invalid_order_object", order };
  }
  if (!ORDER_STATES[toState] && !Object.values(ORDER_STATES).includes(toState)) {
    return { ok: false, error: `unknown_state:${toState}`, order };
  }
  if (isTerminalState(order.state)) {
    return { ok: false, error: `terminal_state:${order.state}`, order };
  }
  if (!canTransition(order.state, toState)) {
    return { ok: false, error: `invalid_transition:${order.state}->${toState}`, order };
  }

  const now = Date.now();
  const next = {
    ...order,
    ...patch,
    state: toState,
    updatedAt: now,
    history: [...order.history, { state: toState, at: now, reason: patch.reason || null }],
  };

  // State-specific bookkeeping
  if (toState === ORDER_STATES.ORDER_PLACED && next.placedAt == null) {
    next.placedAt = now;
  }
  if (isTerminalState(toState)) {
    next.terminalAt = now;
  }
  if (toState === ORDER_STATES.PARTIAL_FILL || toState === ORDER_STATES.FILLED) {
    if (patch.filledSize != null) next.lastFillAt = now;
  }

  return { ok: true, order: next };
}
