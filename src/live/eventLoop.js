// ═══════════════════════════════════════════════════════════════════════
//  src/live/eventLoop.js — continuous trading loop (V5.5 orchestrator)
// ═══════════════════════════════════════════════════════════════════════
//  Pure orchestrator. Owns no order / position / health lifecycle —
//  those live in LiveExecutionEngine, OrderStore, PositionStore, and
//  HealthMonitor respectively.
//
//  Boot sequence (V5.5):
//   1. init approvals + signal handlers
//   2. run startupRecovery (await; live trading blocked until done)
//   3. optional immediate reconciliation
//   4. start the tick loop
//
//  Per tick:
//   1. Kill-switch evaluate (auto-halt on drift / errors / stuck orders)
//   2. Periodic reconciliation (config-driven interval)
//   3. Refresh tradable markets
//   4. Pull orderbooks → feed liveSignals
//   5. Housekeeping: cancel stale orders, periodic openOrders sync
//   6. Build live state snapshot
//   7. Generate signal recommendations
//   8. For each rec: hand to liveExecution.placeOrder (dedup + slippage
//      + risk + FSM inside)
//   9. Emit one structured tick-summary log with health snapshot
//
//  Event-loop errors are caught per-stage so one failure never kills
//  the loop. Errors route to errors.jsonl.
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG, isKillSwitchActive } from "./config.js";
import { getLogger } from "./logger.js";
import { PolymarketClient } from "./polymarketClient.js";
import { Wallet } from "./wallet.js";
import { LiveRiskEngine } from "./liveRisk.js";
import { LiveExecutionEngine } from "./liveExecution.js";
import { LiveSignalEngine } from "./liveSignals.js";
import { buildSignalKey } from "./state/signalDeduper.js";
import { sleep } from "./retry.js";

// V5.5 reliability modules
import { KillSwitch } from "./monitoring/killSwitch.js";
import { HealthMonitor } from "./monitoring/health.js";
import { runStartupRecovery } from "./sync/startupRecovery.js";
import { syncPositions as reconcileWithExchange } from "./sync/reconciliation.js";

export class EventLoop {
  constructor(cfg = LIVE_CONFIG) {
    this.cfg = cfg;
    this.log = getLogger(cfg);
    this.client = new PolymarketClient(cfg, this.log);
    this.wallet = new Wallet(cfg, this.log);
    this.risk = new LiveRiskEngine(cfg, this.log);

    // V5.5: construct kill switch BEFORE execution engine so we can
    // inject it and the execution engine will honour it.
    this.killSwitch = new KillSwitch({
      config: cfg,
      logger: this.log,
      monitoring: cfg.monitoring || {},
    });

    this.exec = new LiveExecutionEngine({
      cfg, logger: this.log,
      client: this.client, wallet: this.wallet, risk: this.risk,
      killSwitch: this.killSwitch,
    });
    this.signals = new LiveSignalEngine(cfg, this.log);

    this.health = new HealthMonitor({
      orderStore: this.exec.orders,
      positionStore: this.exec.positions,
      risk: this.risk,
      killSwitch: this.killSwitch,
      config: cfg,
    });

    this._running = false;
    this._iterCount = 0;
    this._activeTokens = new Map();
    this._recoveryDone = false;
    this._lastReconcileAt = 0;
  }

  /** Pre-flight: approvals, wallet state, startup recovery. */
  async init() {
    this.log.info("=== Event loop starting ===", {
      mode: this.cfg.mode,
      tickMs: this.cfg.loop.tickIntervalMs,
      reconcileIntervalMs: this.cfg.reconciliation?.intervalMs,
      recoveryEnabled: this.cfg.recovery?.enabled,
    });
    await this.exec.init();
    if (this.cfg.mode === "live") {
      await this.wallet.ensureApprovals();
      this.log.info("Approvals verified");
    }
    this._registerSignalHandlers();

    // V5.5: startup recovery must finish before any live trading.
    this.health.recordRecoveryStarted();
    try {
      const summary = await runStartupRecovery({
        client: this.client,
        wallet: this.wallet,
        orderStore: this.exec.orders,
        positionStore: this.exec.positions,
        signalDeduper: this.exec.deduper,
        risk: this.risk,
        killSwitch: this.killSwitch,
        logger: this.log,
        config: this.cfg,
      });
      this.health.recordRecoveryFinished(summary);
      this._recoveryDone = !!summary.ok;
      this.log.info("Recovery complete", {
        ordersRestored: summary.ordersRestored,
        positionsRestored: summary.positionsRestored,
        errors: summary.errors.length,
      });
    } catch (e) {
      this.log.errorEvent("startupRecovery:fatal", e);
      this.health.recordRecoveryFinished({ ok: false, errors: [{ message: e.message }] });
      this._recoveryDone = false;
      // In live mode we refuse to start without successful recovery.
      if (this.cfg.mode === "live") throw e;
    }

    // Optional: immediate reconciliation pass after recovery
    if (this.cfg.reconciliation?.runOnStart) {
      await this._runReconciliation("boot").catch(e =>
        this.log.errorEvent("reconcile:boot", e)
      );
    }

    return true;
  }

  _registerSignalHandlers() {
    const stop = async (sig) => {
      this.log.warn(`Received ${sig}, initiating graceful shutdown`);
      this.killSwitch.triggerManual(`signal:${sig}`);
      this.risk.emergencyStop(`signal:${sig}`);
      try {
        await this.exec.cancelAllOrders();
      } catch (e) {
        this.log.errorEvent("shutdown:cancelAll", e);
      }
      this._running = false;
      this.health.markStopped();
      setTimeout(() => process.exit(0), 1000);
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  }

  /** Run a reconciliation pass against the exchange. */
  async _runReconciliation(trigger = "scheduled") {
    const summary = await reconcileWithExchange({
      client: this.client,
      wallet: this.wallet,
      orderStore: this.exec.orders,
      positionStore: this.exec.positions,
      risk: this.risk,
      killSwitch: this.killSwitch,
      logger: this.log,
      config: this.cfg,
      tokenIds: [...this._activeTokens.keys()],
    });
    this._lastReconcileAt = Date.now();
    this.health.recordReconciliation(summary);
    this.log.info("Reconciliation complete", { trigger, ...summary });
    return summary;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Internal helpers
  // ═══════════════════════════════════════════════════════════════════

  /** Select which tokens to monitor from the tradable market list. */
  async _refreshActiveTokens() {
    try {
      const markets = await this.client.getTradableMarkets();
      const topN = Math.min(markets.length, 20);
      this._activeTokens.clear();
      for (const m of markets.slice(0, topN)) {
        const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : m.tokens || [];
        if (tokens.length > 0) {
          const tokenId = typeof tokens[0] === "string" ? tokens[0] : tokens[0]?.token_id;
          if (tokenId) {
            this._activeTokens.set(tokenId, {
              marketId: m.id || m.conditionId || null,
              question: m.question,
              category: m.category || (m.tags && m.tags[0]),
              adv: Number(m.volume24hr ?? m.volume24Hr ?? 10000),
              endDate: m.endDate,
              tickSize: m.orderPriceMinTickSize || "0.01",
              negRisk: !!m.negRisk,
            });
          }
        }
      }
      this.log.info("Active tokens refreshed", { count: this._activeTokens.size });
    } catch (e) {
      this.log.errorEvent("refreshActiveTokens", e);
    }
  }

  /** Fetch orderbooks for all active tokens and ingest into signals. */
  async _ingestMarketData() {
    const tasks = [...this._activeTokens.entries()].map(async ([tokenId, meta]) => {
      try {
        const book = await this.client.getOrderbook(tokenId);
        this.signals.ingestOrderbook(tokenId, book, meta);
      } catch (e) {
        this.log.errorEvent("ingestOrderbook", e, { tokenId });
      }
    });
    await Promise.all(tasks);
  }

  /** Build live-state snapshot used by processSigs + risk checks. */
  async _buildLiveState() {
    const walletSnap = await this.wallet.snapshot();
    // Pull positions from the PositionStore (source of truth in V5.4)
    const posSnap = this.exec.positions.snapshot();
    const positions = {};
    for (const p of posSnap.positions) {
      positions[p.tokenId] = {
        yesQty: p.qty > 0 ? p.qty : 0,
        noQty: p.qty < 0 ? -p.qty : 0,
      };
    }
    return {
      equity: walletSnap.usdc,
      currentDD: 0,                              // TODO: session high-water
      grossExposure: posSnap.exposure.gross,
      positions,
      cbState: "closed",
    };
  }

  /**
   * Convert an engine recommendation into a placeOrder shape.
   * Returns null if we lack necessary data (book, metadata).
   */
  async _recToOrder(rec) {
    const meta = this._activeTokens.get(rec.cid);
    if (!meta) return null;
    const book = await this.client.getOrderbook(rec.cid).catch(() => null);
    if (!book) return null;

    const side = rec.dir === "BUY_YES" ? "BUY" : "SELL";
    let price = rec.dir === "BUY_YES" ? book.bestAsk : book.bestBid;
    price = Math.max(0.01, Math.min(0.99, price));

    // Deterministic signal key tied to this recommendation's intent
    const signalKey = buildSignalKey({
      source: rec.source || "engine",
      marketId: meta.marketId,
      tokenId: rec.cid,
      side,
      action: rec.urg || "default",
      timestamp: rec.ts || Date.now(),
    });

    return {
      signalKey,
      source: rec.source || "engine",
      marketId: meta.marketId,
      tokenId: rec.cid,
      side,
      price,
      size: rec.sz,
      orderType: rec.urg === "immediate" ? "FOK" : "GTC",
      tickSize: meta.tickSize,
      negRisk: meta.negRisk,
      expectedPrice: book.midPrice,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  One full iteration
  // ═══════════════════════════════════════════════════════════════════
  async tick() {
    const iter = ++this._iterCount;
    const start = Date.now();
    this.health.recordTick();

    // ─── Guard 0: recovery must be complete ────────────────────────
    // In live mode, refuse to trade until recovery finished successfully.
    // Paper mode bypasses this since there's nothing to recover.
    if (this.cfg.mode === "live" && !this._recoveryDone) {
      this.log.warn("Recovery not complete; skipping live trading this tick", { iter });
      return;
    }

    // ─── Guard 1: kill switch (auto + manual) ──────────────────────
    const ksReason = this.killSwitch.evaluate({
      dailyRealizedPnl: this.risk.snapshot().realizedPnlToday,
      openOrders: this.exec.orders.listOpenOrders(),
    });
    if (ksReason) {
      this.log.warn("Kill switch active; skipping tick", { iter, reason: ksReason });
      // If this is the first tick after auto-trigger, cancel remote orders
      try { await this.exec.cancelAllOrders(); } catch (e) { this.log.errorEvent("kill:cancelAll", e); }
      return;
    }
    if (this.risk.isHalted()) {
      this.log.warn("Risk engine halted; skipping tick", { iter });
      return;
    }

    let recs = [];
    let placementResults = [];
    let liveState = null;
    let reconcileSummary = null;

    try {
      // ─── Periodic reconciliation ───────────────────────────────
      const reconInterval = this.cfg.reconciliation?.intervalMs ?? 30000;
      if (this.cfg.mode === "live" && Date.now() - this._lastReconcileAt >= reconInterval) {
        reconcileSummary = await this._runReconciliation("scheduled")
          .catch(e => { this.log.errorEvent("reconcile:scheduled", e); return null; });
      }

      // 1. Refresh tradable markets
      await this._refreshActiveTokens();

      // 2. Pull orderbooks → ingest into signal engine
      await this._ingestMarketData();

      // 3. Housekeeping
      await this.exec.cancelStaleOrders();
      if (iter % 10 === 0) await this.exec.getOpenOrders();
      if (iter % 20 === 0) this.exec.deduper.clearExpired();

      // 4. Build state + generate recs
      liveState = await this._buildLiveState();
      recs = this.signals.generateRecommendations(liveState);

      // 5. For each rec: translate → place. Dedup + slippage + risk inside placeOrder.
      for (const rec of recs) {
        // Quick re-check that nothing halted us mid-iteration
        if (this.killSwitch.isHalted()) break;

        const orderReq = await this._recToOrder(rec);
        if (!orderReq) continue;

        if (this.exec.deduper.has(orderReq.signalKey)) {
          this.log.debug("tick: skipping duplicate signalKey", { signalKey: orderReq.signalKey });
          continue;
        }

        const result = await this.exec.placeOrder(orderReq);
        placementResults.push({
          signalKey: orderReq.signalKey,
          tokenId: orderReq.tokenId,
          side: orderReq.side,
          size: orderReq.size,
          success: result.success,
          orderId: result.orderId || null,
          externalOrderId: result.externalOrderId || null,
          reason: result.reason || null,
        });
      }
    } catch (e) {
      this.log.errorEvent("tick", e, { iter });
    }

    // ─── Structured tick summary with health snapshot ─────────────
    const elapsed = Date.now() - start;
    const snap = this.exec.snapshot();

    // Build livePrices map from the signals engine so health can
    // compute unrealized PnL against the latest mid prices.
    const livePrices = {};
    for (const [tid, m] of this.signals.markets || new Map()) {
      if (m && typeof m.yes === "number") livePrices[tid] = m.yes;
    }
    const healthSnap = this.health.getHealthStatus({ livePrices });

    this.log.decision("tick:summary", {
      iter,
      tsStart: start,
      durationMs: elapsed,
      activeTokens: this._activeTokens.size,
      signals: { count: recs.length, sample: recs.slice(0, 3).map(r => ({ cid: r.cid, dir: r.dir, sz: r.sz, urg: r.urg })) },
      placements: {
        attempted: placementResults.length,
        succeeded: placementResults.filter(p => p.success).length,
        skipped: placementResults.filter(p => !p.success && p.reason?.startsWith("duplicate")).length,
        rejected: placementResults.filter(p => !p.success && !p.reason?.startsWith("duplicate")).length,
      },
      orders: snap.orders,
      positions: {
        count: snap.positions.count,
        grossExposure: snap.positions.exposure.gross,
        realizedPnl: snap.positions.totalRealizedPnl,
      },
      liveState: liveState ? { equity: liveState.equity, grossExposure: liveState.grossExposure } : null,
      risk: snap.risk,
      killSwitch: snap.killSwitch,
      health: {
        running: healthSnap.running,
        halted: healthSnap.halted,
        openOrders: healthSnap.openOrders,
        openPositions: healthSnap.openPositions,
        realizedPnl: healthSnap.realizedPnl,
        unrealizedPnl: healthSnap.unrealizedPnl,
        dailyPnl: healthSnap.dailyPnl,
        apiFailureRate: healthSnap.apiFailureRate,
        consecutiveErrors: healthSnap.consecutiveErrors,
        lastReconcileAt: healthSnap.lastReconcileAt,
        recovery: healthSnap.recovery,
      },
      reconcile: reconcileSummary ? {
        mismatchCount: reconcileSummary.mismatches?.length ?? 0,
        ordersCorrected: reconcileSummary.ordersCorrected,
        positionsCorrected: reconcileSummary.positionsCorrected,
      } : null,
    });
  }

  /** Start the continuous loop. Resolves on stop. */
  async run() {
    this._running = true;
    this.health.markRunning();
    while (this._running) {
      const tickStart = Date.now();
      await this.tick();
      const elapsed = Date.now() - tickStart;
      const wait = Math.max(0, this.cfg.loop.tickIntervalMs - elapsed);
      if (wait > 0) await sleep(wait);
    }
    this.health.markStopped();
    this.log.info("Event loop stopped");
  }

  stop() {
    this._running = false;
  }
}
