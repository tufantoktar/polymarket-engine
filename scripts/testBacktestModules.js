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
import { maxDrawdown, sharpe, tradeStats, allInStats, computeMetrics } from "../src/backtest/metrics.js";
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
//  Exits (V5.9.1)
//
//  Before this, the only way out of a position was an opposing signal on
//  the same token. Tokens rotate out of the tradable set every few
//  minutes, so real runs produced zero SELLs: a 107h recording gave 64
//  fills, all BUY, 25 tokens still open at the end. hitRate and
//  profitFactor were structurally 0 — unmeasurable, not bad.
// ─────────────────────────────────────────────────────────────────────
{
  const dir = path.join(tmpRoot, "exits");
  await writeSyntheticRecording(dir);
  const base = { initialEquity: 10_000, warmupTicks: 35, cooldownMs: 30_000 };

  // Old behaviour is still reachable, and still leaves inventory open.
  const raw = await new Backtester({ opts: { ...base, flattenAtEnd: false } }).run(dir);
  assert("exits: --no-flatten leaves positions open",
    Object.keys(raw.openPositions).length > 0);
  assert("exits: --no-flatten closes nothing", raw.metrics.closedCount === 0);
  assert("exits: --no-flatten records no exits",
    raw.counters.exitsAtEnd === 0 && raw.counters.exitsBySignal === 0);

  // Default flattens, which is what makes the run measurable at all.
  const flat = await new Backtester({ opts: base }).run(dir);
  assert("exits: flattenAtEnd is the default",
    Object.keys(flat.openPositions).length === 0,
    JSON.stringify(flat.openPositions));
  assert("exits: flatten produces a closed trade", flat.metrics.closedCount > 0);
  assert("exits: end-of-run exits counted", flat.counters.exitsAtEnd > 0);

  const endTrades = flat.trades.filter(t => t.exitReason === "end_of_run");
  assert("exits: end-of-run trades are tagged", endTrades.length === flat.counters.exitsAtEnd);
  assert("exits: end-of-run trades are SELLs", endTrades.every(t => t.side === "SELL"));
  assert("exits: closing trade carries book age",
    endTrades.every(t => typeof t.bookAgeMs === "number"),
    JSON.stringify(endTrades.map(t => t.bookAgeMs)));

  // Flattening must realize PnL, not invent it: realized total should
  // move away from zero while equity stays in the same neighbourhood.
  assert("exits: flatten realizes PnL",
    Math.abs(flat.metrics.avgWin) + Math.abs(flat.metrics.avgLoss) > 0);
  assert("exits: flatten does not distort equity wildly",
    Math.abs(flat.metrics.finalEquity - raw.metrics.finalEquity) < raw.metrics.finalEquity * 0.05,
    `raw=${raw.metrics.finalEquity.toFixed(2)} flat=${flat.metrics.finalEquity.toFixed(2)}`);

  // Time stop creates turnover during the run, not just at the end.
  const held = await new Backtester({ opts: { ...base, maxHoldMs: 600_000 } }).run(dir);
  assert("exits: maxHold closes during the run", held.counters.exitsByMaxHold > 0,
    JSON.stringify(held.counters));
  assert("exits: maxHold trades are tagged",
    held.trades.filter(t => t.exitReason === "max_hold").length === held.counters.exitsByMaxHold);
  assert("exits: maxHold yields more closes than flatten alone",
    held.metrics.closedCount > flat.metrics.closedCount);

  // maxHold=0 / null must be a true no-op, not a flatten-everything.
  const off = await new Backtester({ opts: { ...base, maxHoldMs: 0 } }).run(dir);
  assert("exits: maxHold=0 is a no-op", off.counters.exitsByMaxHold === 0);

  // Determinism must survive the new exit paths.
  const d1 = await new Backtester({ opts: { ...base, maxHoldMs: 600_000 } }).run(dir);
  const d2 = await new Backtester({ opts: { ...base, maxHoldMs: 600_000 } }).run(dir);
  const strip = r => JSON.stringify({ m: r.metrics, c: r.counters, t: r.trades });
  assert("exits: deterministic with exits enabled", strip(d1) === strip(d2));
}

// The headline equity number must describe the same world as the trade
// statistics. The equity curve is written per tick, so its last point
// predates the end-of-run flatten; if the report reads finalEquity from
// there, totalReturn and Sharpe stay pre-flatten while hitRate and
// profitFactor are post-flatten. That inconsistency showed up on real
// data as profitFactor 1.81 alongside a -1.53% return.
{
  const dir = path.join(tmpRoot, "consistency");
  await writeSyntheticRecording(dir);
  const r = await new Backtester({
    opts: { initialEquity: 10_000, warmupTicks: 35, cooldownMs: 30_000, maxHoldMs: 600_000 },
  }).run(dir);

  assert("exits: everything is closed after flatten",
    Object.keys(r.openPositions).length === 0);

  const realized = r.trades.reduce((a, t) => a + (t.realized || 0), 0);
  const expected = r.metrics.initialEquity + realized - r.metrics.feesPaid;
  assert("exits: finalEquity equals initialEquity + realized PnL",
    Math.abs(r.metrics.finalEquity - expected) < 0.01,
    `final=${r.metrics.finalEquity.toFixed(4)} expected=${expected.toFixed(4)}`);

  // Sign agreement: a positive profitFactor world cannot report a loss.
  if (r.metrics.profitFactor > 1 && r.metrics.closedCount > 0) {
    assert("exits: profitFactor > 1 implies a non-negative return",
      r.metrics.totalReturnPct >= -0.001,
      `PF=${r.metrics.profitFactor} return=${r.metrics.totalReturnPct}`);
  }
}

// A forced exit must not be blocked by the ENTRY slippage cap.
//
// The entry cap is 2% measured against mid, so a taker SELL is rejected
// whenever half the spread exceeds 2% of mid — routine on Polymarket.
// Applying it to a liquidation reproduces the original bug: the position
// never closes. First real run with max-hold hit this 30,724 times on a
// single stuck position.
{
  const wideBook = {
    midPrice: 0.30,
    bids: [{ price: 0.28, size: 5000 }],   // half-spread = 6.7% of mid
    asks: [{ price: 0.32, size: 5000 }],
  };

  // Entry cap alone: rejected.
  const entryOnly = simulateFill(wideBook, "SELL", 100, { maxSlippagePct: 0.02 });
  assert("exits: entry cap alone would reject a wide-spread exit", !entryOnly.filled);

  // Exit cap: fills, and the cost is visible rather than hidden.
  const bt = new Backtester({ opts: { warmupTicks: 0, flattenAtEnd: true } });
  bt.latestBooks.set("wideTok", wideBook);
  bt.latestBookAt.set("wideTok", 1_000);
  bt.portfolio.applyFill(
    "wideTok", "BUY",
    { filled: true, filledSize: 100, avgPrice: 0.30, notional: 30, fee: 0, slippagePct: 0 },
    1_000,
  );
  bt.lastEventT = 2_000;
  bt._flattenAtEnd();
  assert("exits: forced exit clears a wide-spread position",
    bt.portfolio.position("wideTok").qty === 0);
  assert("exits: forced exit is not counted as stuck", bt.counters.stuckPositions === 0);
  const exitTrade = bt.portfolio.trades.find(t => t.exitReason === "end_of_run");
  assert("exits: forced exit reports the slippage it paid",
    exitTrade && exitTrade.slippagePct > 0.02,
    `slippagePct=${exitTrade?.slippagePct}`);
}

// A failed exit must not be retried against the same book.
{
  const unfillable = { midPrice: 0.30, bids: [], asks: [{ price: 0.32, size: 100 }] };
  const bt = new Backtester({ opts: { warmupTicks: 0, maxHoldMs: 1, flattenAtEnd: false } });
  bt.latestBooks.set("noBid", unfillable);
  bt.latestBookAt.set("noBid", 1_000);
  bt.portfolio.applyFill(
    "noBid", "BUY",
    { filled: true, filledSize: 100, avgPrice: 0.30, notional: 30, fee: 0, slippagePct: 0 },
    1_000,
  );
  bt.openedAt.set("noBid", 1_000);

  bt._applyMaxHold(5_000);
  assert("exits: first failed attempt is counted", bt.counters.exitsFailedRejected === 1);

  // Books update every 10s in a real recording, so the guard must key on
  // price, not on the book timestamp — otherwise nothing is suppressed.
  for (let i = 0; i < 50; i++) {
    bt.latestBookAt.set("noBid", 1_100 + i);   // fresh book, same price
    bt._applyMaxHold(6_000 + i);
  }
  assert("exits: unchanged best bid is not retried",
    bt.counters.exitsFailedRejected === 1,
    `rejected=${bt.counters.exitsFailedRejected}`);
  assert("exits: skipped retries are counted separately",
    bt.counters.exitRetriesSkipped === 50,
    `skipped=${bt.counters.exitRetriesSkipped}`);

  // A CHANGED best bid is a new opportunity and must be tried again.
  bt.latestBooks.set("noBid", { midPrice: 0.30, bids: [{ price: 0.10, size: 1 }], asks: [] });
  bt._applyMaxHold(7_000);
  assert("exits: a changed best bid is retried", bt.counters.exitsFailedRejected === 2);

  // And the retry interval eventually lets a stale price through again.
  bt._applyMaxHold(7_000 + 300_001);
  assert("exits: retry interval eventually re-attempts",
    bt.counters.exitsFailedRejected === 3,
    `rejected=${bt.counters.exitsFailedRejected}`);
}

// Inventory that cannot be liquidated at any recorded price must be
// surfaced, not folded silently into equity.
{
  const bt = new Backtester({ opts: { warmupTicks: 0, flattenAtEnd: true } });
  bt.latestBooks.set("noBid", { midPrice: 0.40, bids: [], asks: [{ price: 0.42, size: 10 }] });
  bt.latestBookAt.set("noBid", 1_000);
  bt.portfolio.applyFill(
    "noBid", "BUY",
    { filled: true, filledSize: 50, avgPrice: 0.40, notional: 20, fee: 0, slippagePct: 0 },
    1_000,
  );
  bt.lastEventT = 2_000;
  bt._flattenAtEnd();
  assert("exits: unliquidatable inventory is counted", bt.counters.stuckPositions === 1);
  assert("exits: unliquidatable inventory reports its notional",
    Math.abs(bt.counters.stuckNotional - 20) < 1e-6,
    `stuckNotional=${bt.counters.stuckNotional}`);
}

// A position whose token never produced a book cannot be closed. We must
// count that rather than silently dropping it.
{
  const bt = new Backtester({ opts: { warmupTicks: 0, flattenAtEnd: true } });
  bt.portfolio.applyFill(
    "ghostToken", "BUY",
    { filled: true, filledSize: 10, avgPrice: 0.5, notional: 5, fee: 0, slippagePct: 0 },
    1_000,
  );
  bt.lastEventT = 2_000;
  bt._flattenAtEnd();
  assert("exits: unclosable position is counted, not dropped",
    bt.counters.exitsFailedNoBook === 1);
  assert("exits: unclosable position stays on the book",
    bt.portfolio.position("ghostToken").qty === 10);
}

// ─────────────────────────────────────────────────────────────────────
//  Survivorship bias in the trade statistics
//
//  A position that goes to zero cannot be sold — no bid remains — so it
//  never becomes a SELL and never enters tradeStats. Winners close;
//  total losers sit in inventory. A real 107h run reported hitRate 84%
//  and profitFactor 10.4 while equity fell, because 63.48 of cost basis
//  was parked in two positions bought near 0.90 that resolved against us.
//
//  allInStats must count those positions as outcomes.
// ─────────────────────────────────────────────────────────────────────
{
  // Three small winners closed, one large loser stuck at zero.
  const trades = [
    { side: "BUY",  realized: 0,  notional: 10 },
    { side: "SELL", realized: 3,  notional: 13 },
    { side: "SELL", realized: 4,  notional: 14 },
    { side: "SELL", realized: 3,  notional: 13 },
  ];
  const stuck = [{ qty: 100, avgPrice: 0.90, markPrice: 0.001 }];   // cost 90, now 0.1

  const closedOnly = tradeStats(trades);
  assert("bias: closed-only sees a perfect record",
    closedOnly.hitRate === 1 && closedOnly.profitFactor === Infinity);

  const allIn = allInStats(trades, stuck);
  assert("bias: all-in counts the stuck position as an outcome",
    allIn.allInCount === 4, `allInCount=${allIn.allInCount}`);
  assert("bias: all-in hit rate drops to 3 of 4",
    Math.abs(allIn.allInHitRate - 0.75) < 1e-9, `hitRate=${allIn.allInHitRate}`);
  assert("bias: all-in profit factor is no longer infinite",
    Number.isFinite(allIn.allInProfitFactor) && allIn.allInProfitFactor < 1,
    `PF=${allIn.allInProfitFactor}`);
  assert("bias: realized is positive while net is negative",
    allIn.realizedPnl > 0 && allIn.netPnl < 0,
    `realized=${allIn.realizedPnl} net=${allIn.netPnl}`);
  assert("bias: unrealized loss equals value minus cost",
    Math.abs(allIn.openUnrealized - (0.1 - 90)) < 1e-6,
    `unrealized=${allIn.openUnrealized}`);
  assert("bias: open cost is reported at cost, not at mark",
    Math.abs(allIn.openCost - 90) < 1e-6, `openCost=${allIn.openCost}`);
  assert("bias: open value is reported separately",
    Math.abs(allIn.openValue - 0.1) < 1e-6, `openValue=${allIn.openValue}`);

  // With nothing stuck the two views must agree.
  const clean = allInStats(trades, []);
  assert("bias: no open inventory means all-in equals closed-only",
    clean.allInHitRate === closedOnly.hitRate &&
    clean.netPnl === clean.realizedPnl);
}

// A stuck position must be reported at cost, not only at market value.
// "worth 0.02" reads as trivial when it represents a total loss of 34.88.
{
  const bt = new Backtester({ opts: { warmupTicks: 0, flattenAtEnd: true } });
  bt.latestBooks.set("dead", { midPrice: 0.001, bids: [], asks: [{ price: 0.002, size: 10 }] });
  bt.latestBookAt.set("dead", 1_000);
  bt.portfolio.applyFill(
    "dead", "BUY",
    { filled: true, filledSize: 100, avgPrice: 0.90, notional: 90, fee: 0, slippagePct: 0 },
    1_000,
  );
  bt.lastEventT = 2_000;
  const report = await bt.run((async function* () {})());

  assert("stuck: cost is reported", Math.abs(report.counters.stuckCost - 90) < 1e-6,
    `stuckCost=${report.counters.stuckCost}`);
  assert("stuck: market value is reported separately",
    report.counters.stuckValue < 1, `stuckValue=${report.counters.stuckValue}`);
  assert("stuck: cost dwarfs market value — that is the point",
    report.counters.stuckCost > report.counters.stuckValue * 100);
  assert("stuck: metrics carry the unrealized loss",
    report.metrics.openUnrealized < -89, `openUnrealized=${report.metrics.openUnrealized}`);
  assert("stuck: net PnL reflects it even though nothing closed",
    report.metrics.netPnl < -89, `netPnl=${report.metrics.netPnl}`);
  assert("stuck: closed-only stats stay empty, which is exactly the trap",
    report.metrics.closedCount === 0);
}

// ─────────────────────────────────────────────────────────────────────
//  Summary
// ─────────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.pass).length;
console.log(`\n══════ Backtest module tests: ${passed}/${results.length} passed ══════`);
if (passed !== results.length) process.exit(1);

await fsp.rm(tmpRoot, { recursive: true, force: true });
