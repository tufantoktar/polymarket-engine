// ═══════════════════════════════════════════════════════════════════════
//  src/live/polymarketClient.js — Polymarket API integration
// ═══════════════════════════════════════════════════════════════════════
//  Single façade over three upstream APIs:
//   - Gamma API  (market metadata, no auth)
//   - CLOB API   (orderbook, order placement, needs L2 auth)
//   - Data API   (positions, trade history, needs HMAC)
//
//  V5.7 / Phase 1: migrated from CLOB V1 (@polymarket/clob-client) to
//  CLOB V2 (@polymarket/clob-client-v2). The V2 SDK is loaded lazily —
//  paper mode never imports it. V2-specific details are localized here
//  and in src/live/execution/v2OrderBuilder.js. The execution_engine
//  contract (placeOrder/cancelOrder/cancelAllOrders/getOpenOrders/
//  getOrderStatus) is stable across V1/V2.
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
import {
  buildV2OrderPayload,
  sanitizeOrderForLog,
} from "./execution/v2OrderBuilder.js";

// V2 SDK package name. Centralized here so swap-out is one-line.
const V2_PACKAGE = "@polymarket/clob-client-v2";

/**
 * PolymarketClient — constructed lazily. In paper mode this never
 * requires the CLOB SDK, keeping paper mode dependency-free.
 */
export class PolymarketClient {
  constructor(cfg = LIVE_CONFIG, logger = null) {
    this.cfg = cfg;
    this.log = logger || getLogger(cfg);
    this._clob = null;           // Real CLOB V2 client (lazy)
    this._signer = null;         // ethers wallet
    this._fetch = globalThis.fetch;
    // Caches
    this._marketsCache = { data: null, ts: 0 };
    this._bookCache = new Map();  // tokenId → { data, ts }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Lazy CLOB SDK init (only when needed in live mode)
  //  V2: uses @polymarket/clob-client-v2 (different constructor surface
  //      and signing flow vs V1).
  // ═══════════════════════════════════════════════════════════════════
  async _getClobClient() {
    if (this._clob) return this._clob;
    if (this.cfg.mode !== "live") {
      throw new Error("CLOB client requested in paper mode — this is a bug");
    }
    if (this.cfg.clob.version !== "v2") {
      throw new Error(
        `CLOB version '${this.cfg.clob.version}' is not supported in Phase 1. ` +
        `Set POLYMARKET_CLOB_VERSION=v2.`
      );
    }

    // Dynamic imports so paper mode never pulls these in.
    let v2, ethers;
    try {
      v2 = await import(V2_PACKAGE);
    } catch (e) {
      throw new Error(
        `Live mode requires the V2 SDK '${V2_PACKAGE}'. ` +
        `Run: npm run install:live`
      );
    }
    try {
      ethers = await import("ethers");
    } catch (e) {
      throw new Error(
        `Live mode requires ethers v5. Run: npm run install:live`
      );
    }

    const c = this.cfg.clob;
    const signer = new ethers.Wallet(c.privateKey);
    this._signer = signer;

    // V2 SDK ctor — accept multiple shapes defensively. Different
    // pre-1.0 V2 builds expose either a `ClobClient` class or a
    // `ClobClientV2` named export.
    const ClientCtor = v2.ClobClient || v2.ClobClientV2 || v2.default;
    if (typeof ClientCtor !== "function") {
      throw new Error(
        `V2 SDK '${V2_PACKAGE}' did not expose a ClobClient/ClobClientV2 ` +
        `constructor. Check the installed version.`
      );
    }

    // Use or derive credentials. The V2 SDK preserves the L1→L2 derive
    // pattern but exposes it as createOrDeriveApiCreds() in some builds.
    let creds = null;
    if (c.apiKey && c.apiSecret && c.apiPassphrase) {
      creds = { key: c.apiKey, secret: c.apiSecret, passphrase: c.apiPassphrase };
    } else {
      const boot = new ClientCtor(c.host, c.chainId, signer);
      const deriveFn = boot.createOrDeriveApiCreds || boot.createOrDeriveApiKey;
      if (typeof deriveFn !== "function") {
        throw new Error(
          "V2 SDK does not expose createOrDeriveApiCreds/createOrDeriveApiKey"
        );
      }
      creds = await deriveFn.call(boot);
      this.log.info("Derived CLOB V2 API credentials from wallet");
    }

    this._clob = new ClientCtor(
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
  //  GAMMA API — market metadata (no auth, unchanged in V2)
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
  //  CLOB API — orderbook (public read; same path in V2)
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
  //  CLOB API — order placement (auth) — V2 path
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Build the V2 order intent (no SDK calls). Pulled out so tests can
   * exercise the conversion path without a live SDK.
   */
  _buildV2Intent(order) {
    const { tokenId, side, price, size } = order;
    const c = this.cfg.clob;
    // Maker / signer: for EOA the same address. For non-EOA, the funder
    // is the maker (holds funds) and the signer signs on its behalf.
    // We require a signer address; for EOA we derive it from the
    // private key (when one is present), otherwise we require maker.
    const signerAddress = order.signerAddress
      || (this._signer ? this._signer.address : null)
      || c.funderAddress
      || null;
    const makerAddress = c.signatureType === 0
      ? signerAddress
      : (c.funderAddress || signerAddress);

    return buildV2OrderPayload({
      tokenId,
      side,
      price,
      size,
      maker: makerAddress,
      signer: signerAddress,
      signatureType: c.signatureType,
      builder: c.builderAddress || "",
      metadata: order.metadata,
    });
  }

  /**
   * Place an order. In paper mode, returns a simulated response.
   * In live mode, uses the V2 SDK.
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
        clobVersion: this.cfg.clob.version,
      };
      this.log.trade("paper:placeOrder", { order: sanitizeOrderForLog(order), response: resp });
      return resp;
    }

    // ─── LIVE / V2 ───────────────────────────────────────────────────
    const client = await this._getClobClient();

    // Build the V2 intent (validation happens inside buildV2OrderPayload).
    const intent = this._buildV2Intent(order);

    // Resolve V2 enums defensively.
    const v2 = await import(V2_PACKAGE);
    const SideEnum = v2.Side || { BUY: "BUY", SELL: "SELL" };
    const OrderTypeEnum = v2.OrderType || { GTC: "GTC", FOK: "FOK", FAK: "FAK", GTD: "GTD" };
    const sideVal = side === "BUY" ? SideEnum.BUY : SideEnum.SELL;
    const otypeVal = OrderTypeEnum[orderType] ?? OrderTypeEnum.GTC;
    const tickSize = order.tickSize || "0.01";
    const negRisk = !!order.negRisk;

    // V2 surface options. The V2 SDK signs+posts; we hand it the raw
    // intent fields (price/size/side) and any V2-specific extras.
    const v2Args = {
      tokenID: tokenId,
      price,
      side: sideVal,
      size,
    };
    const v2Opts = { tickSize, negRisk };

    // Sanitized log of the intent — no signatures, no private keys.
    this.log.trade("live:placeOrder:intent", {
      intent: sanitizeOrderForLog(intent),
      orderType,
      tickSize,
      negRisk,
      clobVersion: "v2",
    });

    // V2 SDK exposes createAndPostOrder; some builds rename to
    // createAndSubmitOrder. Call whichever is present.
    const submit =
      typeof client.createAndPostOrder === "function" ? client.createAndPostOrder.bind(client) :
      typeof client.createAndSubmitOrder === "function" ? client.createAndSubmitOrder.bind(client) :
      null;
    if (!submit) {
      throw new Error("V2 SDK exposes neither createAndPostOrder nor createAndSubmitOrder");
    }

    const resp = await withRetry(
      () => submit(v2Args, v2Opts, otypeVal),
      { label: "clob:placeOrder", logger: this.log }
    );
    this.log.trade("live:placeOrder", {
      order: sanitizeOrderForLog(order),
      response: sanitizeOrderForLog(resp),
      clobVersion: "v2",
    });
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
    // V2: cancelOrder accepts either a string id or an { orderID } object.
    // Older builds wrap; we pass the object form for compatibility.
    const resp = await withRetry(
      () => client.cancelOrder({ orderID: orderId }),
      { label: "clob:cancelOrder", logger: this.log }
    );
    this.log.trade("live:cancelOrder", { orderId, response: sanitizeOrderForLog(resp) });
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
    this.log.trade("live:cancelAllOrders", { response: sanitizeOrderForLog(resp) });
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
    // V2 renamed getOrder → getOrderById in some builds; fall through.
    const fn = client.getOrder || client.getOrderById;
    if (typeof fn !== "function") {
      throw new Error("V2 SDK exposes neither getOrder nor getOrderById");
    }
    return withRetry(
      () => fn.call(client, orderId),
      { label: "clob:getOrderStatus", logger: this.log }
    );
  }

  /** Recent fills for the authenticated wallet (V2). */
  async getFills(opts = {}) {
    if (this.cfg.mode === "paper") return [];
    const client = await this._getClobClient();
    const fn = client.getFills || client.getTrades;
    if (typeof fn !== "function") return [];
    return withRetry(
      () => fn.call(client, opts),
      { label: "clob:getFills", logger: this.log }
    );
  }
}
