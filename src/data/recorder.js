// ═══════════════════════════════════════════════════════════════════════
//  src/data/recorder.js — V5.8 Phase 3: Market data recorder
// ═══════════════════════════════════════════════════════════════════════
//  Records live Polymarket orderbooks (and optionally recent trades) into
//  append-only NDJSON files for offline backtesting.
//
//  Design:
//    - Uses ONLY public read endpoints (Gamma /markets, CLOB /book, /trades).
//      No SDK, no auth, no order placement — safe to run anywhere.
//    - One polling round == one logical "tick". A tick marker event is
//      written after each round so the backtester can replay decision
//      points exactly as the live event loop would see them.
//    - Files rotate hourly: books-YYYYMMDD-HH.ndjson
//
//  Event schema (one JSON object per line):
//    {v:1, type:"session", t, intervalMs, maxTokens}
//    {v:1, type:"meta",    t, tokens:[{tokenId, question, category, adv, endDate, tickSize, negRisk}]}
//    {v:1, type:"book",    t, tokenId, book:{bids, asks, bestBid, bestAsk, midPrice, spread, bidDepth, askDepth}}
//    {v:1, type:"trades",  t, tokenId, trades:[...]}
//    {v:1, type:"tick",    t, seq, books}
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { LIVE_CONFIG } from "../live/config/index.js";
import { getLogger } from "../live/logging/index.js";

export const RECORD_VERSION = 1;

/** Extract the primary (YES) tokenId from a Gamma market object. */
export function parseTokenId(market) {
  try {
    const tokens = market.clobTokenIds
      ? JSON.parse(market.clobTokenIds)
      : market.tokens || [];
    if (!Array.isArray(tokens) || tokens.length === 0) return null;
    const t = tokens[0];
    return typeof t === "string" ? t : t?.token_id || null;
  } catch {
    return null;
  }
}

/** Trim a normalized book to the top N levels per side (keeps files small). */
export function trimBook(book, maxLevels = 10) {
  if (!book) return null;
  return {
    bids: (book.bids || []).slice(0, maxLevels),
    asks: (book.asks || []).slice(0, maxLevels),
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    midPrice: book.midPrice,
    spread: book.spread,
    bidDepth: book.bidDepth,
    askDepth: book.askDepth,
  };
}

function hourStamp(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}`;
}

function resolveDataConfig(cfg) {
  const c = cfg?.data || {};
  return {
    outDir: c.outDir ?? "data/recordings",
    intervalMs: c.intervalMs ?? 10_000,
    maxTokens: c.maxTokens ?? 20,
    bookLevels: c.bookLevels ?? 10,
    recordTrades: c.recordTrades ?? false,
    tradesLimit: c.tradesLimit ?? 50,
    metaRefreshMs: c.metaRefreshMs ?? 5 * 60_000,
  };
}

/**
 * DataRecorder — polls active markets and appends NDJSON events.
 *
 * Usage:
 *   const rec = new DataRecorder({ client });
 *   await rec.start();          // runs until stop()
 *   await rec.stop();
 */
export class DataRecorder {
  constructor({ cfg = LIVE_CONFIG, client, logger = null, overrides = {} } = {}) {
    if (!client) throw new Error("DataRecorder: client is required");
    this.cfg = cfg;
    this.client = client;
    this.log = logger || getLogger(cfg);
    this.dataCfg = { ...resolveDataConfig(cfg), ...overrides };

    this.tokens = new Map();      // tokenId -> meta
    this.seq = 0;
    this.running = false;
    this._timer = null;
    this._stream = null;
    this._streamHour = null;
    this._lastMetaRefresh = 0;
    this._stopResolvers = [];

    this.stats = {
      ticks: 0,
      booksWritten: 0,
      tradesWritten: 0,
      errors: 0,
      bytesWritten: 0,
      startedAt: null,
      currentFile: null,
    };
  }

  // ── file handling ────────────────────────────────────────────────────

  async _ensureStream(ts) {
    const hour = hourStamp(ts);
    if (this._stream && this._streamHour === hour) return;
    await this._closeStream();
    await fsp.mkdir(this.dataCfg.outDir, { recursive: true });
    const file = path.join(this.dataCfg.outDir, `books-${hour}.ndjson`);
    this._stream = fs.createWriteStream(file, { flags: "a" });
    this._streamHour = hour;
    this.stats.currentFile = file;
    this.log.info("Recorder file opened", { file });
  }

  _write(obj) {
    const line = JSON.stringify(obj) + "\n";
    this._stream.write(line);
    this.stats.bytesWritten += Buffer.byteLength(line);
  }

  async _closeStream() {
    if (!this._stream) return;
    const s = this._stream;
    this._stream = null;
    await new Promise(res => s.end(res));
  }

  // ── discovery ────────────────────────────────────────────────────────

  async refreshTokens(now = Date.now()) {
    const markets = await this.client.getTradableMarkets();
    const topN = Math.min(markets.length, this.dataCfg.maxTokens);
    this.tokens.clear();
    for (const m of markets.slice(0, topN)) {
      const tokenId = parseTokenId(m);
      if (!tokenId) continue;
      this.tokens.set(tokenId, {
        tokenId,
        marketId: m.id || m.conditionId || null,
        question: m.question,
        category: m.category || (m.tags && m.tags[0]) || "unknown",
        adv: Number(m.volume24hr ?? m.volume24Hr ?? 0),
        endDate: m.endDate,
        tickSize: m.orderPriceMinTickSize || "0.01",
        negRisk: !!m.negRisk,
      });
    }
    this._lastMetaRefresh = now;
    this._write({ v: RECORD_VERSION, type: "meta", t: now, tokens: [...this.tokens.values()] });
    this.log.info("Recorder tokens refreshed", { count: this.tokens.size });
  }

  // ── polling round ────────────────────────────────────────────────────

  async pollOnce(now = Date.now()) {
    await this._ensureStream(now);

    if (now - this._lastMetaRefresh >= this.dataCfg.metaRefreshMs || this.tokens.size === 0) {
      try {
        await this.refreshTokens(now);
      } catch (e) {
        this.stats.errors++;
        this.log.errorEvent("recorder:refreshTokens", e);
      }
    }

    let books = 0;
    const tasks = [...this.tokens.keys()].map(async tokenId => {
      try {
        const book = await this.client.getOrderbook(tokenId, { force: true });
        this._write({
          v: RECORD_VERSION, type: "book", t: Date.now(), tokenId,
          book: trimBook(book, this.dataCfg.bookLevels),
        });
        books++;
        this.stats.booksWritten++;

        if (this.dataCfg.recordTrades) {
          const trades = await this.client.getRecentTrades(tokenId, this.dataCfg.tradesLimit);
          if (Array.isArray(trades) && trades.length > 0) {
            this._write({ v: RECORD_VERSION, type: "trades", t: Date.now(), tokenId, trades });
            this.stats.tradesWritten++;
          }
        }
      } catch (e) {
        this.stats.errors++;
        this.log.errorEvent("recorder:book", e, { tokenId });
      }
    });
    await Promise.all(tasks);

    this.seq++;
    this.stats.ticks++;
    this._write({ v: RECORD_VERSION, type: "tick", t: Date.now(), seq: this.seq, books });
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  async start() {
    if (this.running) return;
    this.running = true;
    this.stats.startedAt = Date.now();
    await this._ensureStream(Date.now());
    this._write({
      v: RECORD_VERSION, type: "session", t: Date.now(),
      intervalMs: this.dataCfg.intervalMs, maxTokens: this.dataCfg.maxTokens,
    });

    const loop = async () => {
      if (!this.running) return;
      const t0 = Date.now();
      try {
        await this.pollOnce(t0);
      } catch (e) {
        this.stats.errors++;
        this.log.errorEvent("recorder:pollOnce", e);
      }
      if (!this.running) return this._finishStop();
      const elapsed = Date.now() - t0;
      const delay = Math.max(0, this.dataCfg.intervalMs - elapsed);
      this._timer = setTimeout(loop, delay);
    };
    loop();
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      await this._finishStop();
      return;
    }
    // A poll round is mid-flight — wait for it to call _finishStop.
    await new Promise(res => this._stopResolvers.push(res));
  }

  async _finishStop() {
    await this._closeStream();
    this.log.info("Recorder stopped", this.stats);
    for (const res of this._stopResolvers.splice(0)) res();
  }
}
