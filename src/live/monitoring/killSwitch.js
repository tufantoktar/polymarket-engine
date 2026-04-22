// ═══════════════════════════════════════════════════════════════════════
//  src/live/monitoring/killSwitch.js — production halt controller
// ═══════════════════════════════════════════════════════════════════════
//  Extends the lightweight file-sentinel check from V5.3 into a real
//  auto-halt system with five triggers:
//
//    1. Daily realized loss exceeds config.risk.maxDailyLoss
//    2. Consecutive order errors exceed threshold
//    3. API failure rate exceeds threshold over rolling window
//    4. Stuck orders detected (ORDER_PLACED / PARTIAL_FILL past timeout
//       without state progress)
//    5. Manual override: .KILL file OR KILL_SWITCH=1 env (V5.3 behavior preserved)
//
//  When triggered:
//    - halt flag set (permanent for the session — no auto-recovery)
//    - structured reason object recorded
//    - caller is expected to call cancelAllOrders() separately
//
//  The switch is a pure state container — it does not talk to the
//  exchange. liveExecution + eventLoop consult it before acting.
// ═══════════════════════════════════════════════════════════════════════

import { isKillSwitchActive } from "../config.js";
import { ORDER_STATES, isTerminalState } from "../state/orderStateMachine.js";

/** Default thresholds; overridable via config.monitoring. */
const DEFAULTS = {
  maxConsecutiveErrors: 5,
  maxApiFailureRate: 0.5,         // 50% of recent calls failed
  apiWindowSize: 20,
  stuckOrderTimeoutMs: 120_000,
  // maxDailyLoss intentionally omitted — read from config.risk
};

export class KillSwitch {
  /**
   * @param {Object} opts
   *   @param {Object} opts.config    LIVE_CONFIG (for .KILL file path + risk limits)
   *   @param {Object} opts.logger    structured logger
   *   @param {Object} [opts.monitoring] threshold overrides
   */
  constructor({ config, logger, monitoring = {} }) {
    if (!config) throw new Error("KillSwitch: config required");
    if (!logger) throw new Error("KillSwitch: logger required");
    this.cfg = config;
    this.log = logger;
    this.thresholds = {
      maxConsecutiveErrors: monitoring.maxConsecutiveErrors ?? DEFAULTS.maxConsecutiveErrors,
      maxApiFailureRate:    monitoring.maxApiFailureRate    ?? DEFAULTS.maxApiFailureRate,
      apiWindowSize:        monitoring.apiWindowSize        ?? DEFAULTS.apiWindowSize,
      stuckOrderTimeoutMs:  monitoring.stuckOrderTimeoutMs  ?? DEFAULTS.stuckOrderTimeoutMs,
    };

    // Rolling window of recent API outcomes: 1 = success, 0 = failure
    this._apiWindow = [];
    // Counters reset by recordApiSuccess
    this._consecutiveErrors = 0;
    this._lastSuccessAt = Date.now();
    this._lastFailureAt = null;

    // Halt state
    this._halted = false;
    this._reason = null;
    this._haltedAt = null;

    // Stuck-order bookkeeping: orderId → lastProgressAt
    this._orderProgress = new Map();
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Event recorders — these don't themselves halt; evaluate() does.
  // ═══════════════════════════════════════════════════════════════════
  recordApiSuccess() {
    this._apiWindow.push(1);
    this._trimWindow();
    this._consecutiveErrors = 0;
    this._lastSuccessAt = Date.now();
  }
  recordApiFailure(context = {}) {
    this._apiWindow.push(0);
    this._trimWindow();
    this._consecutiveErrors++;
    this._lastFailureAt = Date.now();
    this.log.debug("killSwitch:apiFailure", { consecutive: this._consecutiveErrors, ...context });
  }
  _trimWindow() {
    const cap = this.thresholds.apiWindowSize;
    if (this._apiWindow.length > cap) {
      this._apiWindow.splice(0, this._apiWindow.length - cap);
    }
  }

  /** Called whenever an order transitions to a new state. */
  recordOrderProgress(orderId) {
    if (!orderId) return;
    this._orderProgress.set(orderId, Date.now());
  }
  recordOrderTerminal(orderId) {
    if (!orderId) return;
    this._orderProgress.delete(orderId);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  evaluate — run all auto-triggers and return a reason if halted.
  //
  //  @param {Object} ctx
  //    @param {number} ctx.dailyRealizedPnl   negative = loss
  //    @param {Object[]} [ctx.openOrders]     orders from OrderStore.listOpenOrders()
  //  @returns {null | {trigger, detail, at}}  reason object or null
  // ═══════════════════════════════════════════════════════════════════
  evaluate(ctx = {}) {
    if (this._halted) return this._reason;

    // 1. Manual overrides (.KILL file / env) — preserve V5.3 behavior
    if (isKillSwitchActive(this.cfg)) {
      return this._halt({ trigger: "manual_kill_file", detail: this.cfg.killSwitchFile });
    }

    // 2. Daily loss
    const maxLoss = this.cfg.risk?.maxDailyLoss;
    const pnl = ctx.dailyRealizedPnl;
    if (typeof pnl === "number" && typeof maxLoss === "number" && pnl <= -Math.abs(maxLoss)) {
      return this._halt({
        trigger: "daily_loss",
        detail: { dailyRealizedPnl: +pnl.toFixed(2), limit: maxLoss },
      });
    }

    // 3. Consecutive errors
    if (this._consecutiveErrors >= this.thresholds.maxConsecutiveErrors) {
      return this._halt({
        trigger: "consecutive_errors",
        detail: { count: this._consecutiveErrors, limit: this.thresholds.maxConsecutiveErrors },
      });
    }

    // 4. API failure rate (only once the window is big enough)
    const w = this._apiWindow;
    if (w.length >= Math.min(10, this.thresholds.apiWindowSize)) {
      const failures = w.filter(x => x === 0).length;
      const rate = failures / w.length;
      if (rate >= this.thresholds.maxApiFailureRate) {
        return this._halt({
          trigger: "api_failure_rate",
          detail: { rate: +rate.toFixed(3), failures, samples: w.length, limit: this.thresholds.maxApiFailureRate },
        });
      }
    }

    // 5. Stuck orders
    const stuck = this._detectStuck(ctx.openOrders || []);
    if (stuck.length > 0) {
      return this._halt({
        trigger: "stuck_orders",
        detail: {
          count: stuck.length,
          timeoutMs: this.thresholds.stuckOrderTimeoutMs,
          orders: stuck.slice(0, 5).map(s => ({ orderId: s.orderId, state: s.state, ageMs: s.ageMs })),
        },
      });
    }

    return null;
  }

  _detectStuck(openOrders) {
    const now = Date.now();
    const timeout = this.thresholds.stuckOrderTimeoutMs;
    const stuck = [];
    for (const o of openOrders) {
      if (!o || isTerminalState(o.state)) continue;
      if (o.state !== ORDER_STATES.ORDER_PLACED && o.state !== ORDER_STATES.PARTIAL_FILL) continue;
      const lastProgress = this._orderProgress.get(o.orderId) ?? (o.placedAt || o.createdAt);
      const ageMs = now - lastProgress;
      if (ageMs > timeout) stuck.push({ orderId: o.orderId, state: o.state, ageMs });
    }
    return stuck;
  }

  _halt(reason) {
    if (this._halted) return this._reason;
    this._halted = true;
    this._haltedAt = Date.now();
    this._reason = { ...reason, at: this._haltedAt };
    this.log.error("killSwitch:triggered", this._reason);
    return this._reason;
  }

  /** Force halt from caller (e.g. SIGTERM handler). */
  triggerManual(reason = "manual") {
    return this._halt({ trigger: "manual_api", detail: reason });
  }

  isHalted()         { return this._halted; }
  getReason()        { return this._reason; }
  getLastApiSuccess(){ return this._lastSuccessAt; }

  snapshot() {
    const w = this._apiWindow;
    const rate = w.length > 0 ? +(w.filter(x => x === 0).length / w.length).toFixed(3) : 0;
    return {
      halted: this._halted,
      reason: this._reason,
      haltedAt: this._haltedAt,
      consecutiveErrors: this._consecutiveErrors,
      apiFailureRate: rate,
      apiSamples: w.length,
      lastApiSuccessAt: this._lastSuccessAt,
      lastApiFailureAt: this._lastFailureAt,
      trackedOrders: this._orderProgress.size,
      thresholds: this.thresholds,
    };
  }
}
