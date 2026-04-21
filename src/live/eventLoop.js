// ═══════════════════════════════════════════════════════════════════════
//  src/live/eventLoop.js — continuous trading loop (V5.4 orchestrator)
// ═══════════════════════════════════════════════════════════════════════
//  Pure orchestrator. Owns *no* order lifecycle or position state —
//  those live in LiveExecutionEngine + OrderStore + PositionStore.
//
//  Per tick:
//   1. Kill-switch / halt check
//   2. Refresh tradable markets (cached by polymarketClient TTL)
//   3. Pull orderbooks → feed liveSignals
//   4. Housekeeping: cancel stale orders, periodic openOrders sync
//   5. Build live state snapshot (equity / positions from stores)
//   6. Generate signal recommendations
//   7. For each recommendation: build signalKey, hand to liveExecution.placeOrder
//      (dedup is enforced inside placeOrder — we do a cheap pre-check here
//       only to avoid unnecessary work)
//   8. Emit one structured tick-summary log
//
//  Event-loop errors are caught per-stage so one failure never kills
//  the loop. Errors route to errors.jsonl but the loop continues.
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

export class EventLoop {
  constructor(cfg = LIVE_CONFIG) {
    this.cfg = cfg;
    this.log = getLogger(cfg);
    this.client = new PolymarketClient(cfg, this.log);
    this.wallet = new Wallet(cfg, this.log);
    this.risk = new LiveRiskEngine(cfg, this.log);
    this.exec = new LiveExecutionEngine({
      cfg, logger: this.log,
      client: this.client, wallet: this.wallet, risk: this.risk,
    });
    this.signals = new LiveSignalEngine(cfg, this.log);
    this._running = false;
    this._iterCount = 0;
    this._activeTokens = new Map();   // tokenId → metadata
  }

  /** Pre-flight: sanity checks, approvals, wallet state. */
  async init() {
    this.log.info("=== Event loop starting ===", { mode: this.cfg.mode, tickMs: this.cfg.loop.tickIntervalMs });
    await this.exec.init();
    if (this.cfg.mode === "live") {
      await this.wallet.ensureApprovals();
      this.log.info("Approvals verified");
    }
    this._registerSignalHandlers();
    return true;
  }

  _registerSignalHandlers() {
    const stop = async (sig) => {
      this.log.warn(`Received ${sig}, initiating graceful shutdown`);
      this.risk.emergencyStop(`signal:${sig}`);
      try {
        await this.exec.cancelAllOrders();
      } catch (e) {
        this.log.errorEvent("shutdown:cancelAll", e);
      }
      this._running = false;
      setTimeout(() => process.exit(0), 1000);
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
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

    // Guard: halt / kill-switch
    if (isKillSwitchActive(this.cfg)) {
      this.log.warn("Kill switch active; skipping tick", { iter });
      return;
    }
    if (this.risk.isHalted()) {
      this.log.warn("Risk engine halted; skipping tick", { iter });
      return;
    }

    let recs = [];
    let placementResults = [];
    let liveState = null;

    try {
      // 1. Refresh tradable markets
      await this._refreshActiveTokens();

      // 2. Pull orderbooks → ingest into signal engine
      await this._ingestMarketData();

      // 3. Housekeeping
      await this.exec.cancelStaleOrders();
      if (iter % 10 === 0) await this.exec.getOpenOrders();
      // Periodic dedupe cleanup
      if (iter % 20 === 0) this.exec.deduper.clearExpired();

      // 4. Build state + generate recs
      liveState = await this._buildLiveState();
      recs = this.signals.generateRecommendations(liveState);

      // 5. For each rec: translate → place. Dedup enforced inside placeOrder.
      for (const rec of recs) {
        const orderReq = await this._recToOrder(rec);
        if (!orderReq) continue;

        // Cheap pre-check — avoids a logs.jsonl line for known duplicates
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

    // 6. Structured tick summary — one record per tick for downstream tools
    const elapsed = Date.now() - start;
    const snap = this.exec.snapshot();
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
    });
  }

  /** Start the continuous loop. Resolves on stop. */
  async run() {
    this._running = true;
    while (this._running) {
      const tickStart = Date.now();
      await this.tick();
      const elapsed = Date.now() - tickStart;
      const wait = Math.max(0, this.cfg.loop.tickIntervalMs - elapsed);
      if (wait > 0) await sleep(wait);
    }
    this.log.info("Event loop stopped");
  }

  stop() {
    this._running = false;
  }
}
