// ═══════════════════════════════════════════════════════════════════════
//  src/live/monitoring/health.js — runtime health status aggregator
// ═══════════════════════════════════════════════════════════════════════
//  Read-only composer. Pulls snapshots from the state stores, risk
//  engine, kill switch, and recovery tracker and returns a single
//  JSON-friendly status object suitable for:
//    - per-tick structured logs
//    - CLI health dumps
//    - future HTTP /health endpoint
//
//  No I/O, no mutation. All inputs are injected by the event loop.
// ═══════════════════════════════════════════════════════════════════════

/** HealthMonitor owns only timestamps / counters related to health itself.
 *  Everything else is pulled from the authoritative source at read time. */
export class HealthMonitor {
  constructor(deps = {}) {
    this.orderStore     = deps.orderStore     || null;
    this.positionStore  = deps.positionStore  || null;
    this.risk           = deps.risk           || null;
    this.killSwitch     = deps.killSwitch     || null;
    this.config         = deps.config         || {};

    this._startedAt = Date.now();
    this._running = false;
    this._lastReconcileAt = null;
    this._lastReconcileSummary = null;
    this._recoveryStatus = { status: "not_started", summary: null };
    this._tickCount = 0;
    this._lastTickAt = null;
  }

  // ── Lifecycle hooks ─────────────────────────────────────────────
  markRunning()   { this._running = true; }
  markStopped()   { this._running = false; }
  recordTick()    { this._tickCount++; this._lastTickAt = Date.now(); }

  recordRecoveryStarted()          { this._recoveryStatus = { status: "running", summary: null, startedAt: Date.now() }; }
  recordRecoveryFinished(summary)  { this._recoveryStatus = { status: summary?.ok ? "ok" : "failed", summary, finishedAt: Date.now() }; }

  recordReconciliation(summary) {
    this._lastReconcileAt = Date.now();
    this._lastReconcileSummary = {
      timestamp: summary.timestamp,
      positionsRestored: summary.positionsRestored,
      positionsCorrected: summary.positionsCorrected,
      ordersRestored: summary.ordersRestored,
      ordersCorrected: summary.ordersCorrected,
      mismatchCount: summary.mismatches?.length ?? 0,
      errorCount: summary.errors?.length ?? 0,
    };
  }

  // ── Snapshot ─────────────────────────────────────────────────────
  /**
   * Compose a full health status. Resilient to missing injected deps.
   *
   * Unrealized PnL is not tracked by PositionStore (we don't have live
   * mark prices here). Callers can supply `livePrices` as a
   * tokenId → price map to get a computed value; otherwise null.
   */
  getHealthStatus({ livePrices = null } = {}) {
    const now = Date.now();
    const ordersSnap    = this.orderStore?.snapshot()    ?? { total: 0, open: 0, byState: {} };
    const positionsSnap = this.positionStore?.snapshot() ?? { count: 0, totalRealizedPnl: 0, exposure: { gross: 0, net: 0 }, positions: [] };
    const riskSnap      = this.risk?.snapshot()           ?? {};
    const ksSnap        = this.killSwitch?.snapshot()     ?? { halted: false };

    // Optional unrealized PnL computation
    let unrealizedPnl = null;
    if (livePrices && this.positionStore) {
      unrealizedPnl = 0;
      for (const p of this.positionStore.list()) {
        const px = livePrices[p.tokenId];
        if (typeof px !== "number") continue;
        // For long: (mark - avg) * qty; for short: (avg - mark) * |qty|
        unrealizedPnl += (px - p.avgEntryPrice) * p.qty;
      }
      unrealizedPnl = +unrealizedPnl.toFixed(4);
    }

    const dailyPnl = typeof riskSnap.realizedPnlToday === "number"
      ? riskSnap.realizedPnlToday
      : null;

    return {
      ts: now,
      uptimeMs: now - this._startedAt,

      // Lifecycle
      running: this._running,
      halted: !!ksSnap.halted,
      killSwitchReason: ksSnap.reason || null,

      // Recovery
      recovery: this._recoveryStatus,

      // Tick + reconciliation cadence
      tickCount: this._tickCount,
      lastTickAt: this._lastTickAt,
      lastReconcileAt: this._lastReconcileAt,
      lastReconcileSummary: this._lastReconcileSummary,

      // API health (via kill switch's rolling window)
      lastApiSuccessAt: ksSnap.lastApiSuccessAt ?? null,
      lastApiFailureAt: ksSnap.lastApiFailureAt ?? null,
      consecutiveErrors: ksSnap.consecutiveErrors ?? 0,
      apiFailureRate: ksSnap.apiFailureRate ?? 0,

      // Orders
      openOrders: ordersSnap.open,
      totalOrders: ordersSnap.total,
      ordersByState: ordersSnap.byState,

      // Positions + PnL
      openPositions: positionsSnap.count,
      realizedPnl: positionsSnap.totalRealizedPnl,
      unrealizedPnl,
      dailyPnl,
      grossExposure: positionsSnap.exposure?.gross ?? 0,
      netExposure: positionsSnap.exposure?.net ?? 0,

      // Risk
      risk: {
        day: riskSnap.day,
        rejectsToday: riskSnap.rejectsToday,
        openOrderCount: riskSnap.openOrderCount,
      },
    };
  }

  /**
   * Compact, human-readable single-line summary for CLI tooling.
   */
  getSummaryLine() {
    const s = this.getHealthStatus();
    const statusTag = s.halted ? "HALTED" : s.running ? "LIVE" : "IDLE";
    const pnl = s.realizedPnl >= 0 ? `+${s.realizedPnl}` : `${s.realizedPnl}`;
    return [
      `[${statusTag}]`,
      `uptime=${Math.floor(s.uptimeMs/1000)}s`,
      `ticks=${s.tickCount}`,
      `ord=${s.openOrders}/${s.totalOrders}`,
      `pos=${s.openPositions}`,
      `pnl=${pnl}`,
      `api_err=${s.consecutiveErrors}`,
      s.halted ? `HALT=${s.killSwitchReason?.trigger}` : "",
    ].filter(Boolean).join(" ");
  }
}
