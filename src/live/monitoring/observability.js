// ═══════════════════════════════════════════════════════════════════════
//  src/live/monitoring/observability.js — runtime flags for operators
// ═══════════════════════════════════════════════════════════════════════
//  A small mutable state container that collects inexpensive signals
//  about what the bot is / isn't doing. Exposed through the existing
//  `HealthMonitor` surface.
//
//  Not a replacement for structured logs — this is the "is anything
//  wrong right now?" at-a-glance view. Cheap to update, cheap to read.
//
//  All update methods are idempotent and tolerant of missing inputs so
//  calling them from hot paths is safe.
// ═══════════════════════════════════════════════════════════════════════

export class Observability {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._state = {
      // Is trading blocked right now, and why?
      tradingBlocked: false,
      tradingBlockedReason: null,
      tradingBlockedSince: null,

      // When did the last successful trade (fill) happen?
      lastTradeTimestamp: null,

      // Counters that accumulate over the session
      repeatedDuplicateSignals: 0,
      reconcileMismatchCount: 0,

      // Useful side-counters for alert rules
      lastDuplicateAt: null,
      lastReconcileAt: null,
      lastReconcileMismatchAt: null,
    };
  }

  // ═══════════════════════ mutators (hot paths) ═══════════════════════

  /** Called by killSwitch / risk / tick guards when a tick is blocked. */
  setTradingBlocked(reason) {
    if (!reason) return;
    if (!this._state.tradingBlocked) {
      this._state.tradingBlocked = true;
      this._state.tradingBlockedReason = String(reason);
      this._state.tradingBlockedSince = this._now();
    } else if (this._state.tradingBlockedReason !== String(reason)) {
      // Reason changed — update but don't reset the timestamp
      this._state.tradingBlockedReason = String(reason);
    }
  }

  /** Called when a tick starts successfully and no halt is active. */
  clearTradingBlocked() {
    if (!this._state.tradingBlocked) return;
    this._state.tradingBlocked = false;
    this._state.tradingBlockedReason = null;
    this._state.tradingBlockedSince = null;
  }

  /** Called by liveExecution.applyFill on any fill event. */
  recordFill() {
    this._state.lastTradeTimestamp = this._now();
  }

  /** Called by liveExecution / eventLoop when a duplicate signal is skipped. */
  recordDuplicateSignal() {
    this._state.repeatedDuplicateSignals++;
    this._state.lastDuplicateAt = this._now();
  }

  /** Called after each reconciliation pass. */
  recordReconciliation(summary) {
    this._state.lastReconcileAt = this._now();
    const n = Array.isArray(summary?.mismatches) ? summary.mismatches.length : 0;
    if (n > 0) {
      this._state.reconcileMismatchCount += n;
      this._state.lastReconcileMismatchAt = this._now();
    }
  }

  // ═══════════════════════ readers ═══════════════════════

  /** How long since the last fill, in ms. null if no trade yet this session. */
  noTradeDuration() {
    if (!this._state.lastTradeTimestamp) return null;
    return this._now() - this._state.lastTradeTimestamp;
  }

  /** Full state snapshot. */
  snapshot() {
    return {
      tradingBlocked: this._state.tradingBlocked,
      tradingBlockedReason: this._state.tradingBlockedReason,
      tradingBlockedSince: this._state.tradingBlockedSince,
      lastTradeTimestamp: this._state.lastTradeTimestamp,
      noTradeDuration: this.noTradeDuration(),
      repeatedDuplicateSignals: this._state.repeatedDuplicateSignals,
      reconcileMismatchCount: this._state.reconcileMismatchCount,
      lastDuplicateAt: this._state.lastDuplicateAt,
      lastReconcileAt: this._state.lastReconcileAt,
      lastReconcileMismatchAt: this._state.lastReconcileMismatchAt,
    };
  }

  /** Reset cumulative counters — for tests / operator reset. */
  resetCounters() {
    this._state.repeatedDuplicateSignals = 0;
    this._state.reconcileMismatchCount = 0;
  }
}
