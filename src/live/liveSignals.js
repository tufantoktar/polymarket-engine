// ═══════════════════════════════════════════════════════════════════════
//  src/live/liveSignals.js — bridge CLOB data into engine alpha modules
// ═══════════════════════════════════════════════════════════════════════
//  Connects the live Polymarket orderbook stream to the existing Phase 1
//  signal generators (momSigs, orderflowSigs, arbSigs).
//
//  Responsibilities:
//   - Maintain per-market rolling history from live mid-prices
//   - Convert CLOB book snapshots into the { bidDepth, askDepth, volumeThisTick, ... }
//     shape expected by orderflowSigs()
//   - Call processSigs() with live state (equity, currentDD, grossExposure)
//   - Return sized recommendations for execution
//
//  All randomness / determinism constraints from Phase 1 preserved —
//  this module is stateful (history buffers) but pure functions inside.
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG } from "./config.js";
import { getLogger } from "./logger.js";
import { pushHist } from "../engine/history.js";
import { detectRegime, computeWeights } from "../engine/regime.js";
import { momSigs, orderflowSigs, processSigs } from "../engine/alpha.js";

export class LiveSignalEngine {
  constructor(cfg = LIVE_CONFIG, logger = null) {
    this.cfg = cfg;
    this.log = logger || getLogger(cfg);
    // Per-tokenId state
    this.histories = new Map();   // tokenId → { prices, spreads, depths, maxLen }
    this.regimes = new Map();     // tokenId → regime
    // Lightweight market shape synthesized from CLOB data
    this.markets = new Map();     // tokenId → { id, yes, prevYes, cat, adv, vol, lastUpdate }
    // Lightweight LOB shape for orderflowSigs
    this.lobs = new Map();
    // Running metaPerf (reset per-session; live attribution is handled separately)
    this.metaPerf = { nlp: [], momentum: [], arb: [] };
  }

  /**
   * Ingest one CLOB orderbook snapshot. Synthesizes the "market" shape
   * the engine expects and advances history buffers.
   */
  ingestOrderbook(tokenId, book, meta = {}) {
    if (!book || typeof book.midPrice !== "number") return;
    const now = Date.now();

    // Synthesize market shape
    const prev = this.markets.get(tokenId);
    const market = {
      id: tokenId,
      q: meta.question || tokenId,
      yes: book.midPrice,
      prevYes: prev ? prev.yes : book.midPrice,
      vol: meta.volatility ?? 0.02,
      cat: meta.category || "unknown",
      adv: meta.adv || 10000,
      lastUpdate: now,
    };
    this.markets.set(tokenId, market);

    // Synthesize LOB shape expected by orderflowSigs
    this.lobs.set(tokenId, {
      bidDepth: book.bidDepth,
      askDepth: book.askDepth,
      volumeThisTick: meta.volumeThisTick || 0,
      bids: book.bids,
      asks: book.asks,
    });

    // Advance history buffer
    const hist = this.histories.get(tokenId) || { prices: [], spreads: [], depths: [], maxLen: 300 };
    const depthUsdc = (book.bidDepth + book.askDepth) / 2;
    this.histories.set(tokenId, pushHist(hist, book.midPrice, book.spread, depthUsdc));
  }

  /**
   * Re-compute regime for a token. Cached; call periodically.
   */
  refreshRegime(tokenId) {
    const h = this.histories.get(tokenId);
    if (!h || h.prices.length < 30) return null;
    const regime = detectRegime(h.prices, h.spreads, h.depths);
    this.regimes.set(tokenId, regime);
    return regime;
  }

  /**
   * Generate sized recommendations for all tokens where we have data.
   *
   * @param {Object} live
   *   @param {number} live.equity
   *   @param {number} live.currentDD
   *   @param {number} live.grossExposure
   *   @param {"closed"|"half_open"|"open"} [live.cbState]
   *   @param {Object<string, {yesQty: number, noQty: number}>} [live.positions]
   */
  generateRecommendations(live) {
    const mkts = Object.fromEntries(this.markets);
    const hists = Object.fromEntries(this.histories);
    const lobs = Object.fromEntries(this.lobs);

    // Use the regime of the most-traded token as the "market regime"
    // (same heuristic as src/engine/tick.js btc150k proxy)
    const tokenIds = [...this.markets.keys()];
    let primaryRegime = { trend: "neutral", vol: "low_vol", liq: "high_liq", confidence: 0, hurst: 0.5 };
    if (tokenIds.length > 0) {
      const r = this.refreshRegime(tokenIds[0]);
      if (r) primaryRegime = r;
    }

    const weights = computeWeights(primaryRegime, this.metaPerf, 0);
    const now = Date.now();

    const sigs = [
      ...momSigs(mkts, hists, now, primaryRegime),
      ...orderflowSigs(mkts, lobs, now),
    ];

    this.log.decision("generateSignals", {
      tokenCount: tokenIds.length,
      signalCount: sigs.length,
      regime: primaryRegime,
      weights,
    });

    const liveState = {
      equity: live.equity ?? 1000,
      currentDD: live.currentDD ?? 0,
      grossExposure: live.grossExposure ?? 0,
      positions: live.positions || {},
      markets: mkts,
      cbState: live.cbState || "closed",
    };

    const { recs } = processSigs(sigs, weights, primaryRegime.confidence, now, liveState);
    this.log.decision("recommendations", { count: recs.length, recs: recs.map(r => ({ cid: r.cid, dir: r.dir, sz: r.sz, urg: r.urg })) });
    return recs;
  }

  snapshot() {
    return {
      tokenCount: this.markets.size,
      historyLengths: Object.fromEntries(
        [...this.histories].map(([k, v]) => [k, v.prices.length])
      ),
    };
  }
}
