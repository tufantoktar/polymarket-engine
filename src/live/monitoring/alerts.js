// ═══════════════════════════════════════════════════════════════════════
//  src/live/monitoring/alerts.js — operator-facing warning conditions
// ═══════════════════════════════════════════════════════════════════════
//  Four rules, intentionally simple:
//    1. no_trades       — noTradeDuration > config.noTradeAlertMs
//    2. recovery_pending — startup recovery not complete after N seconds
//    3. duplicate_spam  — repeatedDuplicateSignals >= threshold
//    4. reconcile_drift — reconcileMismatchCount >= threshold
//
//  De-dup strategy per alert:
//    - Each rule has a stable key
//    - While the condition is still true, we only re-log every
//      `cooldownMs` (default 5 min) — no spam
//    - When the condition clears, the next time it triggers it's
//      logged immediately (state change counts as re-trigger)
//
//  Output is structured JSON logs via logger.warn("alert:…", {...})
//  AND an in-memory active-alerts set that `HealthMonitor` can surface.
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

const ALERT_KEYS = Object.freeze({
  NO_TRADES:         "no_trades",
  RECOVERY_PENDING:  "recovery_pending",
  DUPLICATE_SPAM:    "duplicate_spam",
  RECONCILE_DRIFT:   "reconcile_drift",
});

export { ALERT_KEYS };

export class AlertEngine {
  /**
   * @param {Object} opts
   *   @param {Object} opts.logger     structured logger
   *   @param {Object} opts.config     { alerts: {...} } — see defaults below
   *   @param {Function} [opts.now]    Date.now() override for tests
   */
  constructor({ logger, config = {}, now = () => Date.now() }) {
    this.log = logger;
    this.now = now;
    const a = config.alerts || {};
    this.thresholds = {
      noTradeAlertMs:             a.noTradeAlertMs             ?? 10 * 60 * 1000,   // 10 min
      recoveryPendingGraceMs:     a.recoveryPendingGraceMs     ?? 30 * 1000,        // 30 s
      duplicateSignalThreshold:   a.duplicateSignalThreshold   ?? 20,
      reconcileMismatchThreshold: a.reconcileMismatchThreshold ?? 5,
      cooldownMs:                 a.cooldownMs                 ?? DEFAULT_COOLDOWN_MS,
    };

    // Per-alert state: active + lastFiredAt
    this._alerts = new Map();
    for (const k of Object.values(ALERT_KEYS)) {
      this._alerts.set(k, { active: false, lastFiredAt: 0, firstFiredAt: 0, count: 0, detail: null });
    }
  }

  // ═══════════════════════ evaluation ═══════════════════════

  /**
   * Evaluate all rules against a context. Called each tick.
   *
   * @param {Object} ctx
   *   @param {Object}  ctx.observability   Observability.snapshot() output
   *   @param {Object}  ctx.recovery        { status: "not_started"|"running"|"ok"|"failed", startedAt }
   *   @param {number}  ctx.bootAt          when the bot started
   */
  evaluate(ctx = {}) {
    const obs = ctx.observability || {};
    const rec = ctx.recovery || { status: "not_started" };
    const bootAt = ctx.bootAt || this.now();

    this._evalNoTrades(obs);
    this._evalRecoveryPending(rec, bootAt);
    this._evalDuplicateSpam(obs);
    this._evalReconcileDrift(obs);

    return this.listActive();
  }

  _evalNoTrades(obs) {
    const ttl = obs.noTradeDuration;
    // If `lastTradeTimestamp` is null (never traded), we still want to
    // warn eventually — but only after the grace period has passed
    // since boot. We handle that by treating null as "no-trade"
    // indefinitely ONLY once the threshold has elapsed; callers who
    // know the boot time are in ctx.bootAt, but we don't need it here
    // because obs.noTradeDuration stays null before first fill.
    if (ttl == null) return this._clear(ALERT_KEYS.NO_TRADES);
    if (ttl >= this.thresholds.noTradeAlertMs) {
      this._fire(ALERT_KEYS.NO_TRADES, {
        noTradeDurationMs: ttl, threshold: this.thresholds.noTradeAlertMs,
      });
    } else {
      this._clear(ALERT_KEYS.NO_TRADES);
    }
  }

  _evalRecoveryPending(rec, bootAt) {
    const age = this.now() - bootAt;
    // Not complete after grace period? Alert.
    const incomplete = rec.status !== "ok" && rec.status !== "skipped";
    if (incomplete && age >= this.thresholds.recoveryPendingGraceMs) {
      this._fire(ALERT_KEYS.RECOVERY_PENDING, { status: rec.status, ageMs: age });
    } else {
      this._clear(ALERT_KEYS.RECOVERY_PENDING);
    }
  }

  _evalDuplicateSpam(obs) {
    const n = obs.repeatedDuplicateSignals ?? 0;
    if (n >= this.thresholds.duplicateSignalThreshold) {
      this._fire(ALERT_KEYS.DUPLICATE_SPAM, {
        count: n, threshold: this.thresholds.duplicateSignalThreshold,
      });
    } else {
      this._clear(ALERT_KEYS.DUPLICATE_SPAM);
    }
  }

  _evalReconcileDrift(obs) {
    const n = obs.reconcileMismatchCount ?? 0;
    if (n >= this.thresholds.reconcileMismatchThreshold) {
      this._fire(ALERT_KEYS.RECONCILE_DRIFT, {
        count: n, threshold: this.thresholds.reconcileMismatchThreshold,
      });
    } else {
      this._clear(ALERT_KEYS.RECONCILE_DRIFT);
    }
  }

  // ═══════════════════════ internal fire / clear ═══════════════════════

  _fire(key, detail) {
    const now = this.now();
    const alert = this._alerts.get(key);
    if (!alert) return;

    const wasActive = alert.active;
    alert.active = true;
    alert.count++;
    alert.detail = detail;

    // State-change re-trigger: always log the first time it becomes active.
    // Already-active: only log if cooldown elapsed.
    const shouldLog = !wasActive || (now - alert.lastFiredAt >= this.thresholds.cooldownMs);

    if (shouldLog) {
      alert.lastFiredAt = now;
      if (!wasActive) alert.firstFiredAt = now;
      this.log?.warn?.(`alert:${key}`, {
        key, active: true, stateChange: !wasActive,
        count: alert.count,
        firstFiredAt: alert.firstFiredAt,
        cooldownMs: this.thresholds.cooldownMs,
        detail,
      });
    }
  }

  _clear(key) {
    const alert = this._alerts.get(key);
    if (!alert || !alert.active) return;
    alert.active = false;
    alert.detail = null;
    this.log?.info?.(`alert:${key}:cleared`, { key });
  }

  // ═══════════════════════ readers ═══════════════════════

  listActive() {
    const out = [];
    for (const [key, a] of this._alerts) {
      if (a.active) {
        out.push({ key, firstFiredAt: a.firstFiredAt, lastFiredAt: a.lastFiredAt, count: a.count, detail: a.detail });
      }
    }
    return out;
  }

  snapshot() {
    const out = {};
    for (const [key, a] of this._alerts) {
      out[key] = { active: a.active, count: a.count, lastFiredAt: a.lastFiredAt, detail: a.detail };
    }
    return { thresholds: this.thresholds, alerts: out };
  }
}
