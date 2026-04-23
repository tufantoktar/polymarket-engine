import { LIVE_CONFIG } from "../config/index.js";
import { getLogger } from "../logging/index.js";
import { pushHist } from "../../engine/history.js";
import { detectRegime, computeWeights } from "../../engine/regime.js";
import { momSigs, orderflowSigs, processSigs } from "../../engine/alpha.js";

function resolveSignalConfig(cfg) {
  const c = cfg?.signal || {};
  return {
    historyMaxLen: c.historyMaxLen ?? 300,
    defaultVolatility: c.defaultVolatility ?? 0.02,
    defaultCategory: c.defaultCategory ?? "unknown",
    regimeMinPoints: c.regimeMinPoints ?? 30,
    defaultAdv: cfg?.marketScanner?.defaultAdv ?? 10000,
  };
}

/**
 * SignalEngine bridges live orderbook data into the existing alpha pipeline.
 * Interface kept compatible with previous LiveSignalEngine.
 */
export class SignalEngine {
  constructor(cfg = LIVE_CONFIG, logger = null) {
    this.cfg = cfg;
    this.log = logger || getLogger(cfg);
    this.signalCfg = resolveSignalConfig(cfg);

    // Per-tokenId state
    this.histories = new Map();   // tokenId -> { prices, spreads, depths, maxLen }
    this.regimes = new Map();     // tokenId -> regime
    this.markets = new Map();     // tokenId -> synthesized market shape
    this.lobs = new Map();        // tokenId -> synthesized orderflow shape
    this.metaPerf = { nlp: [], momentum: [], arb: [] };
  }

  ingestOrderbook(tokenId, book, meta = {}) {
    if (!book || typeof book.midPrice !== "number") return;
    const now = Date.now();
    const prev = this.markets.get(tokenId);

    const market = {
      id: tokenId,
      q: meta.question || tokenId,
      yes: book.midPrice,
      prevYes: prev ? prev.yes : book.midPrice,
      vol: meta.volatility ?? this.signalCfg.defaultVolatility,
      cat: meta.category || this.signalCfg.defaultCategory,
      adv: meta.adv || this.signalCfg.defaultAdv,
      lastUpdate: now,
    };
    this.markets.set(tokenId, market);

    this.lobs.set(tokenId, {
      bidDepth: book.bidDepth,
      askDepth: book.askDepth,
      volumeThisTick: meta.volumeThisTick || 0,
      bids: book.bids,
      asks: book.asks,
    });

    const hist = this.histories.get(tokenId) || {
      prices: [],
      spreads: [],
      depths: [],
      maxLen: this.signalCfg.historyMaxLen,
    };
    const depthUsdc = (book.bidDepth + book.askDepth) / 2;
    this.histories.set(tokenId, pushHist(hist, book.midPrice, book.spread, depthUsdc));
  }

  refreshRegime(tokenId) {
    const h = this.histories.get(tokenId);
    if (!h || h.prices.length < this.signalCfg.regimeMinPoints) return null;
    const regime = detectRegime(h.prices, h.spreads, h.depths);
    this.regimes.set(tokenId, regime);
    return regime;
  }

  generateRecommendations(live) {
    const mkts = Object.fromEntries(this.markets);
    const hists = Object.fromEntries(this.histories);
    const lobs = Object.fromEntries(this.lobs);

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
    this.log.decision("recommendations", {
      count: recs.length,
      recs: recs.map(r => ({ cid: r.cid, dir: r.dir, sz: r.sz, urg: r.urg })),
    });
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

// Backward-compatible alias with old class name.
export { SignalEngine as LiveSignalEngine };
