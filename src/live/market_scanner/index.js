import { LIVE_CONFIG } from "../config/index.js";
import { getLogger } from "../logging/index.js";
import { buildSignalKey } from "../state/signalDeduper.js";
import { clampProbabilityPrice } from "../shared/utils.js";

function parseTokenIds(market) {
  const tokens = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : market.tokens || [];
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const t = tokens[0];
  return typeof t === "string" ? t : t?.token_id || null;
}

function resolveScannerConfig(cfg) {
  const c = cfg?.marketScanner || {};
  return {
    maxActiveTokens: c.maxActiveTokens ?? 20,
    defaultAdv: c.defaultAdv ?? 10000,
    defaultTickSize: c.defaultTickSize ?? "0.01",
    minPrice: c.minPrice ?? 0.01,
    maxPrice: c.maxPrice ?? 0.99,
  };
}

/**
 * MarketScanner owns tradable token discovery + book ingestion + rec->order mapping.
 */
export class MarketScanner {
  constructor({ cfg = LIVE_CONFIG, logger = null, client, signalEngine } = {}) {
    this.cfg = cfg;
    this.log = logger || getLogger(cfg);
    this.client = client;
    this.signalEngine = signalEngine;
    this.scannerCfg = resolveScannerConfig(cfg);
    this.activeTokens = new Map();
  }

  count() {
    return this.activeTokens.size;
  }

  ids() {
    return [...this.activeTokens.keys()];
  }

  async refreshActiveTokens() {
    try {
      const markets = await this.client.getTradableMarkets();
      const topN = Math.min(markets.length, this.scannerCfg.maxActiveTokens);
      this.activeTokens.clear();

      for (const m of markets.slice(0, topN)) {
        const tokenId = parseTokenIds(m);
        if (!tokenId) continue;

        this.activeTokens.set(tokenId, {
          marketId: m.id || m.conditionId || null,
          question: m.question,
          category: m.category || (m.tags && m.tags[0]),
          adv: Number(m.volume24hr ?? m.volume24Hr ?? this.scannerCfg.defaultAdv),
          endDate: m.endDate,
          tickSize: m.orderPriceMinTickSize || this.scannerCfg.defaultTickSize,
          negRisk: !!m.negRisk,
        });
      }

      this.log.info("Active tokens refreshed", { count: this.activeTokens.size });
    } catch (e) {
      this.log.errorEvent("refreshActiveTokens", e);
    }
  }

  async ingestMarketData() {
    const tasks = [...this.activeTokens.entries()].map(async ([tokenId, meta]) => {
      try {
        const book = await this.client.getOrderbook(tokenId);
        this.signalEngine.ingestOrderbook(tokenId, book, meta);
      } catch (e) {
        this.log.errorEvent("ingestOrderbook", e, { tokenId });
      }
    });
    await Promise.all(tasks);
  }

  async recommendationToOrder(rec) {
    const meta = this.activeTokens.get(rec.cid);
    if (!meta) return null;

    const book = await this.client.getOrderbook(rec.cid).catch(() => null);
    if (!book) return null;

    const side = rec.dir === "BUY_YES" ? "BUY" : "SELL";
    const rawPrice = rec.dir === "BUY_YES" ? book.bestAsk : book.bestBid;
    const price = clampProbabilityPrice(
      rawPrice,
      this.scannerCfg.minPrice,
      this.scannerCfg.maxPrice
    );

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
}
