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

  // ── Exits ───────────────────────────────────────────────────────────
  //  Until V5.9.1 the only way out of a position was an opposing signal
  //  on the same token. Tokens rotate out of the tradable set every few
  //  minutes (volume ranking + time-to-resolution filter), so in practice
  //  positions were never closed: a 107h run produced 64 fills, all BUY,
  //  zero SELL, 25 tokens held open at the end. Every reported return was
  //  therefore mark-to-market on a pile that never resolved, and hitRate
  //  and profitFactor were structurally 0 — not "bad", but unmeasurable.
  //
  //  flattenAtEnd is a MEASUREMENT correction and defaults on: without
  //  it the headline equity number is not a result, it is an opinion
  //  about open inventory.
  //
  //  maxHoldMs is a STRATEGY parameter and defaults off: forcing a time
  //  stop changes what the strategy does, so it must be chosen, not
  //  inherited.
  flattenAtEnd: true,
  maxHoldMs: null,

  //  Exits get their own slippage tolerance. The entry cap (2% of mid)
  //  measures slippage against mid, so a taker SELL is rejected outright
  //  whenever half the spread exceeds 2% of mid — routine for a 1-2c
  //  spread on a sub-$0.50 token. Applying the entry cap to a forced
  //  liquidation recreates the exact bug this feature exists to fix: the
  //  position simply never closes. A forced exit takes the price; the
  //  honest thing is to let it fill and report what it cost, which is
  //  what avgExitSlippageBps is for.
  exitMaxSlippagePct: 0.25,

  //  Minimum gap between exit attempts at an unchanged best bid.
  exitRetryMs: 300_000,

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
    this.latestBookAt = new Map();  // tokenId -> t of that book (staleness)
    this.openedAt = new Map();      // tokenId -> t the position was opened
    this.exitFailedAt = new Map();  // tokenId -> {bestBid, t} of last failed exit
    this.lastEventT = null;
    this.lastFillAt = new Map();    // `${tokenId}:${side}` -> t
    this.curve = [];                // [{t, equity}]
    this.peakEquity = this.opts.initialEquity;

    this.counters = {
      events: 0, books: 0, ticks: 0, decisionTicks: 0,
      recs: 0, fills: 0, partials: 0,
      skippedWarmup: 0, skippedCooldown: 0, skippedNoBook: 0,
      skippedNoPosition: 0, rejectedFills: 0,
      exitsBySignal: 0, exitsByMaxHold: 0, exitsAtEnd: 0,
      exitsFailedNoBook: 0, exitsFailedRejected: 0,
      exitRetriesSkipped: 0, stuckPositions: 0, stuckNotional: 0,
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

    const trade = this.portfolio.applyFill(tokenId, side, fill, t, {
      source: rec.attr ? Object.keys(rec.attr).join("+") : "engine",
      mid: book.midPrice,
    });
    if (trade) {
      if (side === "BUY") {
        if (!this.openedAt.has(tokenId)) this.openedAt.set(tokenId, t);
      } else {
        trade.exitReason = "signal";
        this.counters.exitsBySignal++;
        if (this.portfolio.position(tokenId).qty <= 0) {
          this.openedAt.delete(tokenId);
          this.exitFailedAt.delete(tokenId);
        }
      }
    }
    this.lastFillAt.set(key, t);
    this.counters.fills++;
  }

  /**
   * Close a position against its last recorded book. Used by both the
   * max-hold stop and the end-of-run flatten.
   *
   * Honest-accounting notes:
   *  - We walk the recorded book with the same fill model as any other
   *    order, so the exit pays spread and slippage like a real taker.
   *  - `bookAgeMs` is recorded on the trade. A token that rotated out of
   *    the tradable set hours ago is being closed against a stale book,
   *    and the resulting PnL deserves less trust. Surfacing the age is
   *    better than silently pretending the quote is current.
   */
  _closePosition(tokenId, t, reason) {
    const pos = this.portfolio.position(tokenId);
    if (pos.qty <= 0) return null;

    const book = this.latestBooks.get(tokenId);
    if (!book) { this.counters.exitsFailedNoBook++; return null; }

    const bookAt = this.latestBookAt.get(tokenId);

    // Do not re-attempt at a price we have already failed at. Without a
    // guard the max-hold stop retries every tick for the rest of the run:
    // one stuck position on a 107h recording produced 30,724 identical
    // failures — wasted work, and a counter measuring tick count rather
    // than anything about the position.
    //
    // The guard keys on best bid, not on the book timestamp: books update
    // every 10s, so a timestamp guard would let through ~38k retries. The
    // reason an exit failed is the price, so the same price is the same
    // failure. A retry interval bounds the case where the bid jitters by
    // a tick without ever becoming fillable.
    const bestBid = Number(book.bids?.[0]?.price ?? NaN);
    const lastFail = this.exitFailedAt.get(tokenId);
    // Object.is, not ===: an empty bid side yields NaN, and NaN === NaN is
    // false, which would silently disable the guard on exactly the books
    // that fail most often.
    if (lastFail
        && Object.is(lastFail.bestBid, bestBid)
        && t - lastFail.t < (this.opts.exitRetryMs ?? 0)) {
      this.counters.exitRetriesSkipped++;
      return null;
    }

    const fill = simulateFill(book, "SELL", pos.qty, {
      ...this.opts.fill,
      maxSlippagePct: this.opts.exitMaxSlippagePct ?? this.opts.fill.maxSlippagePct,
    });
    if (!fill.filled) {
      this.counters.exitsFailedRejected++;
      this.exitFailedAt.set(tokenId, { bestBid, t });
      return null;
    }
    this.exitFailedAt.delete(tokenId);
    const trade = this.portfolio.applyFill(tokenId, "SELL", fill, t, {
      source: reason,
      mid: book.midPrice,
    });
    if (trade) {
      trade.exitReason = reason;
      trade.bookAgeMs = typeof bookAt === "number" ? t - bookAt : null;
      if (reason === "max_hold") this.counters.exitsByMaxHold++;
      else if (reason === "end_of_run") this.counters.exitsAtEnd++;
    }
    if (this.portfolio.position(tokenId).qty <= 0) this.openedAt.delete(tokenId);
    return trade;
  }

  /** Time-based stop. No-op unless opts.maxHoldMs is set. */
  _applyMaxHold(t) {
    const maxHold = this.opts.maxHoldMs;
    if (!maxHold || maxHold <= 0) return;
    for (const [tokenId, openedAt] of [...this.openedAt]) {
      if (t - openedAt >= maxHold) this._closePosition(tokenId, t, "max_hold");
    }
  }

  /** Flatten everything still open at the end of the recording. */
  _flattenAtEnd() {
    const t = this.lastEventT ?? Date.now();
    for (const tokenId of [...this.portfolio.positions.keys()]) {
      // The retry guard is irrelevant for the final sweep — this is the
      // last chance to close, so clear it and take the price.
      this.exitFailedAt.delete(tokenId);
      this._closePosition(tokenId, t, "end_of_run");
    }
    // Whatever survives is inventory we could not liquidate at any price
    // the recorded book offered. Count it and its size so it cannot hide
    // inside the equity figure.
    for (const [tokenId, pos] of this.portfolio.positions) {
      const book = this.latestBooks.get(tokenId);
      const px = typeof book?.midPrice === "number" ? book.midPrice : pos.avgPrice;
      this.counters.stuckPositions++;
      this.counters.stuckNotional += pos.qty * px;
    }
    this.counters.stuckNotional = +this.counters.stuckNotional.toFixed(2);
  }

  _onTick(evt) {
    this.counters.ticks++;
    // Time stop runs before new decisions so a position cannot be
    // extended on the same tick it was due to be closed.
    this._applyMaxHold(evt.t);
    if (this.counters.ticks <= this.opts.warmupTicks) {
      this.counters.skippedWarmup++;
    } else {
      this.counters.decisionTicks++;
      // Replay clock, not wall clock. Recorded events carry their own
      // timestamps; any signal that filters on event age (smart money's
      // lookback window) must be evaluated against the recording's own
      // notion of "now" or it will discard the entire recording.
      const recs = this.signalEngine.generateRecommendations(this._liveState(), evt.t);
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
      if (typeof evt.t === "number") this.lastEventT = evt.t;
      switch (evt.type) {
        case "meta":
          for (const tok of evt.tokens || []) this.tokenMeta.set(tok.tokenId, tok);
          break;
        case "book": {
          if (!evt.book) break;
          this.counters.books++;
          this.latestBooks.set(evt.tokenId, evt.book);
          if (typeof evt.t === "number") this.latestBookAt.set(evt.tokenId, evt.t);
          const meta = this.tokenMeta.get(evt.tokenId) || {};
          this.signalEngine.ingestOrderbook(evt.tokenId, evt.book, {
            question: meta.question,
            category: meta.category,
            adv: meta.adv,
          });
          break;
        }
        case "wallet_trades":
          if (Array.isArray(evt.trades) && evt.trades.length > 0) {
            this.signalEngine.ingestWalletTrades(evt.trades);
          }
          break;
        case "tick":
          this._onTick(evt);
          break;
        default:
          break; // session, trades, unknown → ignored for now
      }
    }
    if (this.opts.flattenAtEnd) {
      this._flattenAtEnd();
      // The equity curve is written per tick, so its last point predates
      // the flatten. Without this the report mixes two accounting worlds:
      // finalEquity / totalReturn / Sharpe would still be pre-flatten
      // mark-to-market while hitRate / profitFactor describe realized
      // trades. That is how a run can show profitFactor 1.81 and a
      // negative return at the same time.
      this.curve.push({
        t: this.lastEventT ?? (this.curve.at(-1)?.t ?? 0),
        equity: this.portfolio.equity(this._midPrices()),
      });
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
        tickCount: this.counters.ticks,
      }),
      openPositions: Object.fromEntries(this.portfolio.positions),
      trades: this.portfolio.trades,
    };
  }
}
