// ═══════════════════════════════════════════════════════════════════════
//  src/live/eventLoop.js — continuous trading loop
// ═══════════════════════════════════════════════════════════════════════
//  Orchestrates one iteration:
//   1. Kill-switch check
//   2. Refresh tradable market list (cached per loop.marketRefreshMs)
//   3. For each active token: fetch orderbook, ingest into signal engine
//   4. Generate recommendations
//   5. Hand off to liveExecution.placeOrder()
//   6. Cancel stale orders
//   7. Sleep until next tick
//
//  All stages wrapped in try/catch so a single failure never kills the
//  loop. Errors log to errors.jsonl but the loop continues.
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG, isKillSwitchActive } from "./config.js";
import { getLogger } from "./logger.js";
import { PolymarketClient } from "./polymarketClient.js";
import { Wallet } from "./wallet.js";
import { LiveRiskEngine } from "./liveRisk.js";
import { LiveExecutionEngine } from "./liveExecution.js";
import { LiveSignalEngine } from "./liveSignals.js";
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
    // Tokens we're actively monitoring this session
    this._activeTokens = new Map(); // tokenId → metadata
  }

  /** Pre-flight: sanity checks, approvals, wallet state. */
  async init() {
    this.log.info("=== Event loop starting ===", { mode: this.cfg.mode, tickMs: this.cfg.loop.tickIntervalMs });
    await this.exec.init();
    if (this.cfg.mode === "live") {
      // Ensure approvals before any live trading
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
      // Give the current iteration a moment to unwind before exit
      setTimeout(() => process.exit(0), 1000);
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  }

  /** Select which tokens to monitor from the tradable market list. */
  async _refreshActiveTokens() {
    try {
      const markets = await this.client.getTradableMarkets();
      // Limit to top N by volume to keep each iteration fast
      const topN = Math.min(markets.length, 20);
      this._activeTokens.clear();
      for (const m of markets.slice(0, topN)) {
        // Polymarket markets have two tokens: YES and NO
        const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : m.tokens || [];
        if (tokens.length > 0) {
          // We primarily trade the YES token; NO is implied (1 - YES price)
          const tokenId = typeof tokens[0] === "string" ? tokens[0] : tokens[0]?.token_id;
          if (tokenId) {
            this._activeTokens.set(tokenId, {
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
    // Convert tokenId → position qty into the { yesQty, noQty } shape
    // expected by the engine. In live mode we don't yet distinguish YES
    // tokens from their NO twins in this module — a refinement for later.
    const positions = {};
    for (const [tid, qty] of this.exec.positions) {
      positions[tid] = { yesQty: qty > 0 ? qty : 0, noQty: qty < 0 ? -qty : 0 };
    }
    return {
      equity: walletSnap.usdc,
      currentDD: 0,          // TODO: compute from session high vs current equity
      grossExposure: 0,      // TODO: compute from positions × prices
      positions,
      cbState: "closed",
    };
  }

  /** One full iteration of the loop. */
  async tick() {
    const iter = ++this._iterCount;
    const start = Date.now();
    this.log.debug(`Tick ${iter} start`);

    if (isKillSwitchActive(this.cfg)) {
      this.log.warn("Kill switch active; skipping tick");
      return;
    }
    if (this.risk.isHalted()) {
      this.log.warn("Risk engine halted; skipping tick");
      return;
    }

    try {
      // 1. Refresh market list (cache handles TTL internally)
      await this._refreshActiveTokens();

      // 2. Pull orderbooks
      await this._ingestMarketData();

      // 3. Cancel stale open orders
      await this.exec.cancelStaleOrders();

      // 4. Sync open orders with remote truth (every 10 iterations)
      if (iter % 10 === 0) {
        await this.exec.getOpenOrders();
      }

      // 5. Build live state and generate recommendations
      const liveState = await this._buildLiveState();
      const recs = this.signals.generateRecommendations(liveState);

      // 6. Submit recommendations
      for (const rec of recs) {
        const meta = this._activeTokens.get(rec.cid);
        if (!meta) continue;
        // Convert engine rec → order shape
        const book = await this.client.getOrderbook(rec.cid).catch(() => null);
        if (!book) continue;

        const side = rec.dir === "BUY_YES" ? "BUY" : "SELL";
        // Price: cross the spread slightly for immediate urgency, else passive near mid
        let price = rec.dir === "BUY_YES" ? book.bestAsk : book.bestBid;
        // Clamp to valid range
        price = Math.max(0.01, Math.min(0.99, price));

        await this.exec.placeOrder({
          tokenId: rec.cid,
          side,
          price,
          size: rec.sz,
          orderType: rec.urg === "immediate" ? "FOK" : "GTC",
          tickSize: meta.tickSize,
          negRisk: meta.negRisk,
          expectedPrice: book.midPrice,
        });
      }

      const elapsed = Date.now() - start;
      this.log.debug(`Tick ${iter} done`, {
        durationMs: elapsed,
        recs: recs.length,
        activeTokens: this._activeTokens.size,
        risk: this.risk.snapshot(),
      });
    } catch (e) {
      this.log.errorEvent("tick", e, { iter });
    }
  }

  /** Start the continuous loop. Returns a promise that resolves on stop. */
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
