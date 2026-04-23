// ═══════════════════════════════════════════════════════════════════════
//  src/live/polymarketClient.js — Polymarket API integration
// ═══════════════════════════════════════════════════════════════════════
//  Single façade over three upstream APIs:
//   - Gamma API  (market metadata, no auth)
//   - CLOB API   (orderbook, order placement, needs L2 auth)
//   - Data API   (positions, trade history, needs HMAC)
//
//  Local cache with TTL avoids hammering endpoints. All network calls
//  are wrapped in withRetry() for exponential backoff.
//
//  Paper mode:
//    In paper mode we still fetch market/orderbook data for realism, but
//    any order-placement call returns a simulated response instead of
//    hitting the CLOB. This lets the live event loop exercise the real
//    network path with zero financial risk.
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG } from "./config/index.js";
import { getLogger } from "./logging/index.js";
import { withRetry, sleep } from "./retry.js";

/**
 * PolymarketClient — constructed lazily. In paper mode this never
 * requires the CLOB SDK, keeping paper mode dependency-free.
 */
export class PolymarketClient {
  constructor(cfg = LIVE_CONFIG, logger = null) {
    this.cfg = cfg;
    this.log = logger || getLogger(cfg);
    this._clob = null;           // Real CLOB client (lazy)
    this._fetch = globalThis.fetch;
    // Caches
    this._marketsCache = { data: null, ts: 0 };
    this._bookCache = new Map();  // tokenId → { data, ts }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Lazy CLOB SDK init (only when needed in live mode)
  // ═══════════════════════════════════════════════════════════════════
  async _getClobClient() {
    if (this._clob) return this._clob;
    if (this.cfg.mode !== "live") {
      throw new Error("CLOB client requested in paper mode — this is a bug");
    }
    // Dynamic import so paper mode never pulls in the SDK
    let ClobClient, ethers;
    try {
      ({ ClobClient } = await import("@polymarket/clob-client"));
      ethers = await import("ethers");
    } catch (e) {
      throw new Error(
        "Live mode requires @polymarket/clob-client and ethers. " +
        "Run: npm install @polymarket/clob-client ethers@^5"
      );
    }

    const c = this.cfg.clob;
    const signer = new ethers.Wallet(c.privateKey);

    // Use or derive credentials
    let creds = null;
    if (c.apiKey && c.apiSecret && c.apiPassphrase) {
      creds = { key: c.apiKey, secret: c.apiSecret, passphrase: c.apiPassphrase };
    } else {
      // Derive from wallet — requires L1 auth first
      const boot = new ClobClient(c.host, c.chainId, signer);
      creds = await boot.createOrDeriveApiKey();
      this.log.info("Derived CLOB API credentials from wallet");
    }

    this._clob = new ClobClient(
      c.host,
      c.chainId,
      signer,
      creds,
      c.signatureType,
      c.funderAddress || undefined,
    );
    return this._clob;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  GAMMA API — market metadata (no auth)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Fetch all currently-active markets from Gamma API.
   * Cached per-config TTL.
   */
  async getMarkets({ force = false } = {}) {
    const now = Date.now();
    const ttl = this.cfg.loop.marketRefreshMs;
    if (!force && this._marketsCache.data && now - this._marketsCache.ts < ttl) {
      return this._marketsCache.data;
    }
    const url = `${this.cfg.clob.gammaHost}/markets?active=true&closed=false&limit=200&order=volume24hr&ascending=false`;
    const data = await withRetry(
      async () => {
        const res = await this._fetch(url);
        if (!res.ok) {
          const err = new Error(`Gamma /markets failed: ${res.status}`);
          err.status = res.status;
          throw err;
        }
        return res.json();
      },
      { label: "gamma:getMarkets", logger: this.log }
    );
    this._marketsCache = { data, ts: now };
    return data;
  }

  /**
   * Filter markets according to config.filters.
   * Returns subset suitable for trading (volume, spread, depth, time-to-resolution).
   */
  async getTradableMarkets() {
    const markets = await this.getMarkets();
    const f = this.cfg.filters;
    const now = Date.now();
    return markets.filter(m => {
      if (!m || m.closed) return false;
      // Volume filter
      const vol = Number(m.volume24hr ?? m.volume24Hr ?? 0);
      if (vol < f.minVolume24h) return false;
      // Time-to-resolution filter
      if (m.endDate) {
        const end = new Date(m.endDate).getTime();
        const hours = (end - now) / (1000 * 60 * 60);
        if (hours < f.minHoursToResolution) return false;
      }
      // Category filter
      if (f.allowedCategories.length > 0) {
        const cats = m.tags || m.categories || [];
        if (!cats.some(t => f.allowedCategories.includes(t))) return false;
      }
      return true;
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CLOB API — orderbook (public read)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Orderbook for a single token.
   * Returns { bids: [{price, size}], asks: [...], midPrice, spread, bidDepth, askDepth }.
   */
  async getOrderbook(tokenId, { force = false } = {}) {
    if (!tokenId) throw new Error("getOrderbook: tokenId required");
    const now = Date.now();
    const ttl = this.cfg.loop.orderbookRefreshMs;
    const cached = this._bookCache.get(tokenId);
    if (!force && cached && now - cached.ts < ttl) return cached.data;

    const url = `${this.cfg.clob.host}/book?token_id=${encodeURIComponent(tokenId)}`;
    const raw = await withRetry(
      async () => {
        const res = await this._fetch(url);
        if (!res.ok) {
          const err = new Error(`CLOB /book failed: ${res.status}`);
          err.status = res.status;
          throw err;
        }
        return res.json();
      },
      { label: "clob:getOrderbook", logger: this.log }
    );

    const bids = (raw.bids || []).map(b => ({ price: Number(b.price), size: Number(b.size) }))
                                 .sort((a, b) => b.price - a.price);
    const asks = (raw.asks || []).map(a => ({ price: Number(a.price), size: Number(a.size) }))
                                 .sort((a, b) => a.price - b.price);

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 1;
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const bidDepth = bids.reduce((s, x) => s + x.size * x.price, 0);
    const askDepth = asks.reduce((s, x) => s + x.size * x.price, 0);

    const data = { tokenId, bids, asks, bestBid, bestAsk, midPrice, spread, bidDepth, askDepth, fetchedAt: now };
    this._bookCache.set(tokenId, { data, ts: now });
    return data;
  }

  /** Recent trades for a token (public). */
  async getRecentTrades(tokenId, limit = 50) {
    const url = `${this.cfg.clob.host}/trades?market=${encodeURIComponent(tokenId)}&limit=${limit}`;
    return withRetry(
      async () => {
        const res = await this._fetch(url);
        if (!res.ok) {
          const err = new Error(`CLOB /trades failed: ${res.status}`);
          err.status = res.status;
          throw err;
        }
        return res.json();
      },
      { label: "clob:getRecentTrades", logger: this.log }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CLOB API — order placement (auth)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Place an order. In paper mode, returns a simulated response.
   * In live mode, uses the CLOB SDK.
   *
   * @param {Object} order
   *   @param {string} order.tokenId  outcome token ID (YES or NO)
   *   @param {"BUY"|"SELL"} order.side
   *   @param {number} order.price    tick-aligned price in [0.01, 0.99]
   *   @param {number} order.size     contracts
   *   @param {"GTC"|"FOK"|"FAK"} [order.orderType]
   *   @param {string} [order.tickSize]  e.g. "0.01" or "0.001"
   *   @param {boolean} [order.negRisk]
   */
  async placeOrder(order) {
    const { tokenId, side, price, size } = order;
    if (!tokenId) throw new Error("placeOrder: tokenId required");
    if (!["BUY", "SELL"].includes(side)) throw new Error("placeOrder: side must be BUY or SELL");
    if (!(price > 0 && price < 1)) throw new Error("placeOrder: price must be in (0, 1)");
    if (!(size > 0)) throw new Error("placeOrder: size must be > 0");

    const orderType = order.orderType || this.cfg.execution.defaultOrderType;

    if (this.cfg.mode === "paper") {
      // Simulated placement — returns a synthetic ID and treats as resting
      const id = `paper_${Date.now()}_${Math.floor(Math.random() * 1e6).toString(16)}`;
      const resp = {
        success: true,
        orderID: id,
        status: "resting",
        paper: true,
        placedAt: Date.now(),
      };
      this.log.trade("paper:placeOrder", { order, response: resp });
      return resp;
    }

    // LIVE
    const client = await this._getClobClient();
    const SideEnum = (await import("@polymarket/clob-client")).Side;
    const OrderTypeEnum = (await import("@polymarket/clob-client")).OrderType;
    const sideVal = side === "BUY" ? SideEnum.BUY : SideEnum.SELL;
    const otypeVal = OrderTypeEnum[orderType] ?? OrderTypeEnum.GTC;
    const tickSize = order.tickSize || "0.01";
    const negRisk = !!order.negRisk;

    const resp = await withRetry(
      () => client.createAndPostOrder(
        { tokenID: tokenId, price, side: sideVal, size },
        { tickSize, negRisk },
        otypeVal,
      ),
      { label: "clob:placeOrder", logger: this.log }
    );
    this.log.trade("live:placeOrder", { order, response: resp });
    return resp;
  }

  /** Cancel an open order by id. */
  async cancelOrder(orderId) {
    if (!orderId) throw new Error("cancelOrder: orderId required");
    if (this.cfg.mode === "paper") {
      this.log.trade("paper:cancelOrder", { orderId });
      return { success: true, canceled: [orderId], paper: true };
    }
    const client = await this._getClobClient();
    const resp = await withRetry(
      () => client.cancelOrder({ orderID: orderId }),
      { label: "clob:cancelOrder", logger: this.log }
    );
    this.log.trade("live:cancelOrder", { orderId, response: resp });
    return resp;
  }

  /** Cancel all open orders (safety/kill-switch use). */
  async cancelAllOrders() {
    if (this.cfg.mode === "paper") {
      this.log.trade("paper:cancelAllOrders", {});
      return { success: true, paper: true };
    }
    const client = await this._getClobClient();
    const resp = await withRetry(
      () => client.cancelAll(),
      { label: "clob:cancelAll", logger: this.log }
    );
    this.log.trade("live:cancelAllOrders", { response: resp });
    return resp;
  }

  /** Fetch open orders for the current wallet. */
  async getOpenOrders() {
    if (this.cfg.mode === "paper") return [];
    const client = await this._getClobClient();
    return withRetry(
      () => client.getOpenOrders(),
      { label: "clob:getOpenOrders", logger: this.log }
    );
  }

  /** Status of a specific order. */
  async getOrderStatus(orderId) {
    if (this.cfg.mode === "paper") {
      return { orderID: orderId, status: "resting", paper: true };
    }
    const client = await this._getClobClient();
    return withRetry(
      () => client.getOrder(orderId),
      { label: "clob:getOrderStatus", logger: this.log }
    );
  }
}
