// ═══════════════════════════════════════════════════════════════════════
//  src/backtest/runner.js — V5.8 Phase 3: Backtest engine
// ═══════════════════════════════════════════════════════════════════════
//  Replays a recording through the UNMODIFIED production alpha pipeline:
//
//    replayEvents ─▶ SignalEngine.ingestOrderbook (same as live)
//         │
//         ├─ tick marker ─▶ SignalEngine.generateRecommendations
//         │                     │
//         │                     ▶ rec → side/size (same mapping as
//         │                       MarketScanner.recommendationToOrder)
//         │                     ▶ simulateFill against recorded depth
//         │                     ▶ BacktestPortfolio.applyFill
//         │
//         └─ equity mark-to-mid per tick ─▶ metrics
//
//  Determinism: given the same recording + options, output is identical.
//  The engine's PRNG is not used on this path; all state is derived from
//  recorded events.
//
//  Semantics note (mirrors live long-only behavior):
//    BUY_YES → BUY (open/extend YES position at recorded asks)
//    BUY_NO  → SELL (reduce existing YES position at recorded bids);
//              with no open position the rec is skipped and counted.
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG } from "../live/config/index.js";
import { SignalEngine } from "../live/signal_engine/index.js";
import { replayEvents } from "./replay.js";
import { simulateFill, DEFAULT_FILL_OPTS } from "./fillModel.js";
import { BacktestPortfolio } from "./portfolio.js";
import { computeMetrics } from "./metrics.js";

const SILENT_LOG = {
  info: () => {}, warn: () => {}, debug: () => {}, error: () => {},
  decision: () => {}, trade: () => {}, errorEvent: () => {},
};

export const DEFAULT_BACKTEST_OPTS = {
  initialEquity: 1000,
  warmupTicks: 30,          // matches signal.regimeMinPoints default
  cooldownMs: 60_000,       // min gap between fills on same token+side
  fill: { ...DEFAULT_FILL_OPTS },
};

export class Backtester {
  constructor({ cfg = LIVE_CONFIG, opts = {} } = {}) {
    this.cfg = cfg;
    this.opts = {
      ...DEFAULT_BACKTEST_OPTS,
      ...opts,
      fill: { ...DEFAULT_FILL_OPTS, ...(opts.fill || {}) },
    };

    this.signalEngine = new SignalEngine(cfg, SILENT_LOG);
    this.portfolio = new BacktestPortfolio({ initialEquity: this.opts.initialEquity });

    this.tokenMeta = new Map();     // tokenId -> meta (from "meta" events)
    this.latestBooks = new Map();   // tokenId -> last recorded book
    this.lastFillAt = new Map();    // `${tokenId}:${side}` -> t
    this.curve = [];                // [{t, equity}]
    this.peakEquity = this.opts.initialEquity;

    this.counters = {
      events: 0, books: 0, ticks: 0, decisionTicks: 0,
      recs: 0, fills: 0, partials: 0,
      skippedWarmup: 0, skippedCooldown: 0, skippedNoBook: 0,
      skippedNoPosition: 0, rejectedFills: 0,
      parse: {},                    // filled by replayEvents
    };
  }

  _midPrices() {
    const prices = new Map();
    for (const [tokenId, book] of this.latestBooks) {
      if (typeof book?.midPrice === "number") prices.set(tokenId, book.midPrice);
    }
    return prices;
  }

  _liveState() {
    const prices = this._midPrices();
    const equity = this.portfolio.equity(prices);
    if (equity > this.peakEquity) this.peakEquity = equity;
    const positions = {};
    for (const [tokenId, pos] of this.portfolio.positions) {
      positions[tokenId] = { yesQty: pos.qty, noQty: 0 };
    }
    return {
      equity,
      currentDD: this.peakEquity > 0 ? (this.peakEquity - equity) / this.peakEquity : 0,
      grossExposure: this.portfolio.grossExposure(prices),
      positions,
      cbState: "closed",
    };
  }

  _handleRec(rec, t) {
    this.counters.recs++;
    const tokenId = rec.cid;
    const book = this.latestBooks.get(tokenId);
    if (!book) { this.counters.skippedNoBook++; return; }

    const side = rec.dir === "BUY_YES" ? "BUY" : "SELL";
    if (side === "SELL" && this.portfolio.position(tokenId).qty <= 0) {
      this.counters.skippedNoPosition++;
      return;
    }

    const key = `${tokenId}:${side}`;
    const last = this.lastFillAt.get(key) || 0;
    if (t - last < this.opts.cooldownMs) { this.counters.skippedCooldown++; return; }

    const fill = simulateFill(book, side, rec.sz, this.opts.fill);
    if (!fill.filled) { this.counters.rejectedFills++; return; }
    if (fill.reason === "partial") this.counters.partials++;

    this.portfolio.applyFill(tokenId, side, fill, t, {
      source: rec.attr ? Object.keys(rec.attr).join("+") : "engine",
      mid: book.midPrice,
    });
    this.lastFillAt.set(key, t);
    this.counters.fills++;
  }

  _onTick(evt) {
    this.counters.ticks++;
    if (this.counters.ticks <= this.opts.warmupTicks) {
      this.counters.skippedWarmup++;
    } else {
      this.counters.decisionTicks++;
      const recs = this.signalEngine.generateRecommendations(this._liveState());
      for (const rec of recs) this._handleRec(rec, evt.t);
    }
    this.curve.push({ t: evt.t, equity: this.portfolio.equity(this._midPrices()) });
  }

  /**
   * Run over a recording directory, file list, or any async iterable of
   * events. Returns the full report.
   */
  async run(source) {
    const events =
      typeof source === "string" || Array.isArray(source)
        ? replayEvents(source, this.counters.parse)
        : source;

    for await (const evt of events) {
      this.counters.events++;
      switch (evt.type) {
        case "meta":
          for (const tok of evt.tokens || []) this.tokenMeta.set(tok.tokenId, tok);
          break;
        case "book": {
          if (!evt.book) break;
          this.counters.books++;
          this.latestBooks.set(evt.tokenId, evt.book);
          const meta = this.tokenMeta.get(evt.tokenId) || {};
          this.signalEngine.ingestOrderbook(evt.tokenId, evt.book, {
            question: meta.question,
            category: meta.category,
            adv: meta.adv,
          });
          break;
        }
        case "tick":
          this._onTick(evt);
          break;
        default:
          break; // session, trades, unknown → ignored for now
      }
    }
    return this.report();
  }

  report() {
    return {
      generatedAt: new Date().toISOString(),
      opts: this.opts,
      counters: this.counters,
      metrics: computeMetrics({
        curve: this.curve,
        trades: this.portfolio.trades,
        initialEquity: this.opts.initialEquity,
        feesPaid: this.portfolio.feesPaid,
      }),
      openPositions: Object.fromEntries(this.portfolio.positions),
      trades: this.portfolio.trades,
    };
  }
}
