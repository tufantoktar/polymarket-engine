import { LIVE_CONFIG } from "../config/index.js";
import { getLogger } from "../logging/index.js";
import { pushHist } from "../../engine/history.js";
import { detectRegime, computeWeights } from "../../engine/regime.js";
import { momSigs, orderflowSigs, processSigs } from "../../engine/alpha.js";
import { smartMoneySigs } from "../../engine/smartMoney.js";

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
    this.walletTrades = new Map(); // tokenId -> WalletTrade[] (ring buffer, V5.9)
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

  /**
   * V5.9: ingest a batch of normalized wallet trades (any tokens; only
   * those matching tracked markets accumulate history). Each trade:
   * {tokenId, wallet, side: "BUY"|"SELL", price, size, ts, isMarketMaker?}.
   * Maintains a per-token ring buffer capped at cfg.smartMoney.maxTradesPerToken.
   */
  ingestWalletTrades(trades) {
    if (!Array.isArray(trades) || trades.length === 0) return;
    const cap = this.cfg?.smartMoney?.maxTradesPerToken ?? 500;
    for (const t of trades) {
      if (!t || !t.tokenId) continue;
      const arr = this.walletTrades.get(t.tokenId) || [];
      arr.push(t);
      if (arr.length > cap) arr.splice(0, arr.length - cap);
      this.walletTrades.set(t.tokenId, arr);
    }
  }

  refreshRegime(tokenId) {
    const h = this.histories.get(tokenId);
    if (!h || h.prices.length < this.signalCfg.regimeMinPoints) return null;
    const regime = detectRegime(h.prices, h.spreads, h.depths);
    this.regimes.set(tokenId, regime);
    return regime;
  }

  /**
   * @param {Object} live       live sizing state (equity, DD, positions, ...)
   * @param {number} [now]      decision clock, epoch ms.
   *
   * `now` exists because signals are not all generated from live state:
   * smart-money signals are derived from RECORDED trade timestamps. When
   * the backtester replays a recording, wall-clock `Date.now()` is hours
   * or days ahead of the data, so every recorded trade falls outside the
   * lookback window and the signal can never fire. Replay must therefore
   * be able to supply its own clock. Live callers omit it and get
   * `Date.now()`, which is the same behaviour as before.
   */
  generateRecommendations(live, now = Date.now()) {
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

    const sigs = [
      ...momSigs(mkts, hists, now, primaryRegime),
      ...orderflowSigs(mkts, lobs, now),
    ];
    if (this.cfg?.smartMoney?.enabled) {
      const walletTrades = Object.fromEntries(this.walletTrades);
      sigs.push(...smartMoneySigs(mkts, walletTrades, now, this.cfg.smartMoney));
    }

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
