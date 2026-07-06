// ═══════════════════════════════════════════════════════════════════════
//  scripts/testBacktestModules.js — V5.8 Phase 3 tests
// ═══════════════════════════════════════════════════════════════════════
//  Coverage:
//    - recorder: NDJSON session/meta/book/tick events via fake client,
//      tick seq monotonicity, graceful stop, hourly filename
//    - trimBook / parseTokenId helpers
//    - replay: file ordering, gz support, corrupt-line skip counting
//    - fillModel: full/multi-level/partial fills, slippage cap, sides,
//      empty book rejection
//    - portfolio: avg-cost basis, realized/unrealized PnL, equity, clamp
//    - metrics: drawdown, returns, trade stats on known series
//    - e2e: synthetic recording → Backtester; determinism across runs;
//      production signal pipeline produces fills on trending data
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

import { DataRecorder, trimBook, parseTokenId, RECORD_VERSION } from "../src/data/recorder.js";
import { listRecordingFiles, replayEvents } from "../src/backtest/replay.js";
import { simulateFill } from "../src/backtest/fillModel.js";
import { BacktestPortfolio } from "../src/backtest/portfolio.js";
import { maxDrawdown, sharpe, tradeStats, computeMetrics } from "../src/backtest/metrics.js";
import { Backtester } from "../src/backtest/runner.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  if (!cond) console.error(`  FAIL ${name}${detail ? ": " + detail : ""}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const silentLog = {
  info: () => {}, warn: () => {}, debug: () => {}, error: () => {},
  decision: () => {}, trade: () => {}, errorEvent: () => {},
};

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "pm-bt-"));

// ─────────────────────────────────────────────────────────────────────
//  1. Helpers
// ─────────────────────────────────────────────────────────────────────
{
  const tid = parseTokenId({ clobTokenIds: JSON.stringify(["111", "222"]) });
  assert("parseTokenId: clobTokenIds string array", tid === "111");
  const tid2 = parseTokenId({ tokens: [{ token_id: "abc" }] });
  assert("parseTokenId: tokens object array", tid2 === "abc");
  assert("parseTokenId: garbage → null", parseTokenId({ clobTokenIds: "{bad" }) === null);

  const big = {
    bids: Array.from({ length: 30 }, (_, i) => ({ price: 0.5 - i * 0.01, size: 10 })),
    asks: Array.from({ length: 30 }, (_, i) => ({ price: 0.51 + i * 0.01, size: 10 })),
    bestBid: 0.5, bestAsk: 0.51, midPrice: 0.505, spread: 0.01, bidDepth: 100, askDepth: 100,
  };
  const t = trimBook(big, 5);
  assert("trimBook: levels capped", t.bids.length === 5 && t.asks.length === 5);
  assert("trimBook: aggregates preserved", t.midPrice === 0.505 && t.bidDepth === 100);
}

// ─────────────────────────────────────────────────────────────────────
//  2. Recorder with fake client
// ─────────────────────────────────────────────────────────────────────
{
  const fakeBook = mid => ({
    bids: [{ price: mid - 0.005, size: 100 }],
    asks: [{ price: mid + 0.005, size: 100 }],
    bestBid: mid - 0.005, bestAsk: mid + 0.005,
    midPrice: mid, spread: 0.01, bidDepth: 50, askDepth: 50,
  });
  let mid = 0.5;
  const fakeClient = {
    getTradableMarkets: async () => [
      { id: "m1", question: "Q1?", clobTokenIds: JSON.stringify(["tokA"]), volume24hr: 5000, category: "test" },
      { id: "m2", question: "Q2?", clobTokenIds: JSON.stringify(["tokB"]), volume24hr: 4000, category: "test" },
    ],
    getOrderbook: async () => fakeBook((mid += 0.001)),
    getRecentTrades: async () => [{ price: mid, size: 1 }],
  };

  const dir = path.join(tmpRoot, "rec");
  const rec = new DataRecorder({
    client: fakeClient, logger: silentLog,
    overrides: { outDir: dir, intervalMs: 1, maxTokens: 5, recordTrades: true },
  });

  await rec._ensureStream(Date.now());
  rec._write({ v: RECORD_VERSION, type: "session", t: Date.now(), intervalMs: 1, maxTokens: 5 });
  await rec.pollOnce();
  await rec.pollOnce();
  await rec.pollOnce();
  await rec._closeStream();

  const files = await listRecordingFiles(dir);
  assert("recorder: one hourly file", files.length === 1 && /books-\d{8}-\d{2}\.ndjson$/.test(files[0]));

  const counts = {};
  let lastSeq = 0, seqOk = true;
  for await (const evt of replayEvents(files)) {
    counts[evt.type] = (counts[evt.type] || 0) + 1;
    if (evt.type === "tick") {
      if (evt.seq !== lastSeq + 1) seqOk = false;
      lastSeq = evt.seq;
    }
  }
  assert("recorder: session written", counts.session === 1);
  assert("recorder: meta on first poll", counts.meta === 1);
  assert("recorder: 2 tokens × 3 polls books", counts.book === 6, JSON.stringify(counts));
  assert("recorder: trades recorded", counts.trades === 6);
  assert("recorder: 3 tick markers, monotonic seq", counts.tick === 3 && seqOk);
  assert("recorder: stats consistent", rec.stats.ticks === 3 && rec.stats.booksWritten === 6);
}

// ─────────────────────────────────────────────────────────────────────
//  3. Replay: ordering, gz, corrupt lines
// ─────────────────────────────────────────────────────────────────────
{
  const dir = path.join(tmpRoot, "replay");
  await fsp.mkdir(dir, { recursive: true });
  const l = obj => JSON.stringify(obj) + "\n";

  await fsp.writeFile(path.join(dir, "books-20260101-00.ndjson"),
    l({ type: "book", t: 1, tokenId: "x" }) + "NOT JSON\n" + l({ type: "tick", t: 2, seq: 1 }));
  const gz = zlib.gzipSync(l({ type: "book", t: 3, tokenId: "x" }) + l({ type: "tick", t: 4, seq: 2 }));
  await fsp.writeFile(path.join(dir, "books-20260101-01.ndjson.gz"), gz);

  const counters = {};
  const seen = [];
  for await (const evt of replayEvents(dir, counters)) seen.push(evt.t);
  assert("replay: chronological across files (incl. gz)", JSON.stringify(seen) === "[1,2,3,4]");
  assert("replay: corrupt line skipped & counted", counters.skipped === 1 && counters.parsed === 4);
  assert("replay: file count", counters.files === 2);
}

// ─────────────────────────────────────────────────────────────────────
//  4. Fill model
// ─────────────────────────────────────────────────────────────────────
{
  const book = {
    midPrice: 0.50,
    bids: [{ price: 0.49, size: 100 }, { price: 0.48, size: 100 }],
    asks: [{ price: 0.51, size: 50 }, { price: 0.52, size: 50 }, { price: 0.60, size: 500 }],
  };

  const f1 = simulateFill(book, "BUY", 30, { maxSlippagePct: 0.05 });
  assert("fill: single-level full", f1.filled && f1.filledSize === 30 && near(f1.avgPrice, 0.51));

  const f2 = simulateFill(book, "BUY", 100, { maxSlippagePct: 0.05 });
  assert("fill: multi-level VWAP", f2.filled && f2.filledSize === 100 && near(f2.avgPrice, 0.515));
  assert("fill: slippage reported", near(f2.slippagePct, (0.515 - 0.5) / 0.5));

  // Third level (0.60) breaches 5% cap → partial stop at 100 shares
  const f3 = simulateFill(book, "BUY", 200, { maxSlippagePct: 0.05, allowPartial: true });
  assert("fill: slippage cap stops walk (partial)", f3.filled && f3.filledSize === 100 && f3.reason === "partial");

  const f4 = simulateFill(book, "BUY", 200, { maxSlippagePct: 0.05, allowPartial: false });
  assert("fill: partial disallowed → reject", !f4.filled && f4.reason === "partial_disallowed");

  const f5 = simulateFill(book, "SELL", 150, { maxSlippagePct: 0.05 });
  assert("fill: sell walks bids", f5.filled && f5.filledSize === 150 && near(f5.avgPrice, (100 * 0.49 + 50 * 0.48) / 150));

  const f6 = simulateFill({ midPrice: 0.5, bids: [], asks: [] }, "BUY", 10, {});
  assert("fill: empty book rejected", !f6.filled && f6.reason === "empty_side");

  const f7 = simulateFill(book, "BUY", 10, { maxSlippagePct: 0.001 });
  assert("fill: tight cap rejects everything", !f7.filled && f7.reason === "slippage_or_no_depth");

  const f8 = simulateFill(book, "BUY", 100, { feeBps: 100 });
  assert("fill: fee = bps of notional", near(f8.fee, f8.notional * 0.01));
}

// ─────────────────────────────────────────────────────────────────────
//  5. Portfolio accounting
// ─────────────────────────────────────────────────────────────────────
{
  const pf = new BacktestPortfolio({ initialEquity: 1000 });
  const mk = (avgPrice, filledSize, fee = 0) => ({
    filled: true, filledSize, avgPrice, notional: avgPrice * filledSize, fee, slippagePct: 0,
  });

  pf.applyFill("tokA", "BUY", mk(0.50, 100), 1);
  pf.applyFill("tokA", "BUY", mk(0.60, 100), 2);
  const pos = pf.position("tokA");
  assert("portfolio: avg cost basis", pos.qty === 200 && near(pos.avgPrice, 0.55));
  assert("portfolio: cash after buys", near(pf.cash, 1000 - 50 - 60));

  const u = pf.unrealizedPnl(new Map([["tokA", 0.65]]));
  assert("portfolio: unrealized PnL", near(u, 200 * 0.10));
  assert("portfolio: equity mark-to-mid", near(pf.equity(new Map([["tokA", 0.65]])), 890 + 130));

  pf.applyFill("tokA", "SELL", mk(0.70, 150), 3);
  assert("portfolio: realized on partial close", near(pf.realizedPnl, 150 * 0.15));
  assert("portfolio: remaining qty", near(pf.position("tokA").qty, 50));

  // Over-sell clamps to available (no shorting)
  pf.applyFill("tokA", "SELL", mk(0.70, 500), 4);
  assert("portfolio: sell clamped, position closed", pf.position("tokA").qty === 0);
  assert("portfolio: sell with no position is no-op",
    pf.applyFill("tokA", "SELL", mk(0.70, 10), 5) === null);

  const expectedCash = 1000 - 110 + 150 * 0.70 + 50 * 0.70;
  assert("portfolio: final cash reconciles", near(pf.cash, expectedCash));
}

// ─────────────────────────────────────────────────────────────────────
//  6. Metrics
// ─────────────────────────────────────────────────────────────────────
{
  const curve = [
    { t: 0, equity: 100 }, { t: 1000, equity: 110 }, { t: 2000, equity: 99 },
    { t: 3000, equity: 121 }, { t: 4000, equity: 121 },
  ];
  assert("metrics: max drawdown", near(maxDrawdown(curve), (110 - 99) / 110));
  assert("metrics: flat curve sharpe 0", sharpe([{ t: 0, equity: 1 }, { t: 1, equity: 1 }]) === 0);

  const trades = [
    { side: "BUY", realized: 0, notional: 50, slippagePct: 0.001 },
    { side: "SELL", realized: 10, notional: 60, slippagePct: 0.002 },
    { side: "SELL", realized: -4, notional: 30, slippagePct: 0.003 },
  ];
  const ts = tradeStats(trades);
  assert("metrics: hit rate", near(ts.hitRate, 0.5));
  assert("metrics: profit factor", near(ts.profitFactor, 10 / 4));
  assert("metrics: avg slippage bps", near(ts.avgSlippageBps, 20));

  const rep = computeMetrics({ curve, trades, initialEquity: 100, feesPaid: 1.5 });
  assert("metrics: total return pct", near(rep.totalReturnPct, 21));
  assert("metrics: fees passthrough", rep.feesPaid === 1.5);
}

// ─────────────────────────────────────────────────────────────────────
//  7. End-to-end: synthetic recording → production pipeline → fills
// ─────────────────────────────────────────────────────────────────────
async function writeSyntheticRecording(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const lines = [];
  const push = o => lines.push(JSON.stringify(o));
  const t0 = 1_700_000_000_000;

  push({ v: 1, type: "session", t: t0, intervalMs: 10_000, maxTokens: 1 });
  push({
    v: 1, type: "meta", t: t0,
    tokens: [{ tokenId: "tokTREND", marketId: "m1", question: "Will it trend?", category: "test", adv: 50_000, tickSize: "0.01", negRisk: false }],
  });

  // 150 ticks: steady uptrend 0.40 → 0.55 with heavy bid-side imbalance
  let mid = 0.40;
  for (let i = 1; i <= 150; i++) {
    mid += 0.001;
    const t = t0 + i * 10_000;
    const book = {
      bids: [
        { price: +(mid - 0.005).toFixed(4), size: 4000 },
        { price: +(mid - 0.015).toFixed(4), size: 4000 },
      ],
      asks: [
        { price: +(mid + 0.005).toFixed(4), size: 900 },
        { price: +(mid + 0.015).toFixed(4), size: 900 },
      ],
      bestBid: +(mid - 0.005).toFixed(4),
      bestAsk: +(mid + 0.005).toFixed(4),
      midPrice: +mid.toFixed(4),
      spread: 0.01,
      bidDepth: 4000 * mid, askDepth: 900 * mid,
    };
    push({ v: 1, type: "book", t, tokenId: "tokTREND", book });
    push({ v: 1, type: "tick", t, seq: i, books: 1 });
  }
  await fsp.writeFile(path.join(dir, "books-20260101-00.ndjson"), lines.join("\n") + "\n");
}

{
  const dir = path.join(tmpRoot, "e2e");
  await writeSyntheticRecording(dir);

  const opts = { initialEquity: 10_000, warmupTicks: 35, cooldownMs: 30_000 };
  const r1 = await new Backtester({ opts }).run(dir);
  const r2 = await new Backtester({ opts }).run(dir);

  assert("e2e: all ticks processed", r1.counters.ticks === 150 && r1.counters.decisionTicks === 115);
  assert("e2e: books ingested", r1.counters.books === 150);
  assert("e2e: signal pipeline produced recommendations", r1.counters.recs > 0,
    `recs=${r1.counters.recs}`);
  assert("e2e: fills executed against recorded depth", r1.counters.fills > 0,
    `fills=${r1.counters.fills} rejected=${r1.counters.rejectedFills}`);
  assert("e2e: equity curve complete", r1.curve === undefined && r1.metrics.ticks === 150);

  const strip = r => JSON.stringify({ m: r.metrics, c: r.counters, t: r.trades, p: r.openPositions });
  assert("e2e: deterministic across runs", strip(r1) === strip(r2));

  // Uptrend + BUY_YES entries marked to rising mid → PnL should not be negative
  assert("e2e: trending long PnL sane", r1.metrics.finalEquity >= r1.metrics.initialEquity * 0.98,
    `final=${r1.metrics.finalEquity.toFixed(2)}`);
}

// ─────────────────────────────────────────────────────────────────────
//  Summary
// ─────────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.pass).length;
console.log(`\n══════ Backtest module tests: ${passed}/${results.length} passed ══════`);
if (passed !== results.length) process.exit(1);

await fsp.rm(tmpRoot, { recursive: true, force: true });
