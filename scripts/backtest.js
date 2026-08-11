// ═══════════════════════════════════════════════════════════════════════
//  scripts/backtest.js — V5.8 Phase 3: Backtest CLI
// ═══════════════════════════════════════════════════════════════════════
//  Replays a recording through the production alpha pipeline and prints
//  a performance report.
//
//  Usage:
//    npm run backtest -- --data=data/recordings
//    npm run backtest -- --data=data/recordings --equity=1000 --warmup=30
//    npm run backtest -- --data=data/recordings --fee-bps=0 --max-slippage=0.02
//    npm run backtest -- --data=data/recordings --report=reports/run1.json
//    npm run backtest -- --data=data/recordings --max-hold=60    (minutes)
//    npm run backtest -- --data=data/recordings --no-flatten     (raw, unmeasurable)
// ═══════════════════════════════════════════════════════════════════════

import fsp from "node:fs/promises";
import path from "node:path";

import { Backtester } from "../src/backtest/runner.js";

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dataDir = args.data || "data/recordings";

const opts = {};
if (args.equity) opts.initialEquity = Number(args.equity);
if (args.warmup) opts.warmupTicks = Number(args.warmup);
if (args.cooldown) opts.cooldownMs = Number(args.cooldown) * 1000;
opts.fill = {};
if (args["fee-bps"]) opts.fill.feeBps = Number(args["fee-bps"]);
if (args["max-slippage"]) opts.fill.maxSlippagePct = Number(args["max-slippage"]);
if (args["max-hold"]) opts.maxHoldMs = Number(args["max-hold"]) * 60_000;
if (args["no-flatten"]) opts.flattenAtEnd = false;

const fmt = (n, d = 2) => (typeof n === "number" && isFinite(n) ? n.toFixed(d) : String(n));

console.log(`[backtest] replaying: ${dataDir}`);
const bt = new Backtester({ opts });

let report;
try {
  report = await bt.run(dataDir);
} catch (e) {
  console.error(`[backtest] failed: ${e.message}`);
  process.exit(1);
}

const m = report.metrics;
const c = report.counters;

// ─── Exit-quality commentary ──────────────────────────────────────────
//  A run whose exits are overwhelmingly "endOfRun" has not demonstrated
//  anything: the strategy never chose to leave a position, the harness
//  simply liquidated whatever was left when the tape ran out. Say so
//  plainly rather than letting a tidy hitRate imply otherwise.
const totalExits = c.exitsBySignal + c.exitsByMaxHold + c.exitsAtEnd;
const endShare = totalExits > 0 ? c.exitsAtEnd / totalExits : 0;

const exitTrades = (report.trades || []).filter(t => t.exitReason && t.exitReason !== "signal");
const avgExitSlipBps = exitTrades.length
  ? exitTrades.reduce((a, t) => a + (t.slippagePct || 0) * 10_000, 0) / exitTrades.length
  : 0;
const maxBookAgeMin = exitTrades.length
  ? Math.max(...exitTrades.map(t => (t.bookAgeMs ?? 0))) / 60_000
  : 0;

const exitFailNote = c.stuckPositions
  ? ` stuck=${c.stuckPositions}`
  : "";

let exitWarning = "";
if (report.opts.flattenAtEnd === false) {
  exitWarning =
    "WARNING: --no-flatten — open positions are left unrealized. Equity,\n" +
    "hitRate and profitFactor below are NOT measurements.\n";
} else if (totalExits === 0) {
  exitWarning =
    "WARNING: no position was ever closed. Nothing here is a measurement.\n";
} else if (endShare >= 0.8) {
  exitWarning =
    `WARNING: ${(endShare * 100).toFixed(0)}% of exits were end-of-run liquidations,\n` +
    "not strategy decisions. The strategy has no working exit; these\n" +
    "numbers describe the harness, not an edge. Consider --max-hold.\n";
}
if (c.stuckPositions > 0) {
  exitWarning +=
    `NOTE: ${c.stuckPositions} position(s) worth ${fmt(c.stuckNotional)} could not be\n` +
    "liquidated at any recorded price. That value is still inside the\n" +
    "equity figure above and has not been realized.\n";
}
if (maxBookAgeMin > 60) {
  exitWarning +=
    `NOTE: oldest exit priced against a book ${fmt(maxBookAgeMin, 0)} min stale — the\n` +
    "token had rotated out of the tradable set. Treat its PnL with care.\n";
}

console.log(`
════════════════════════ BACKTEST REPORT ════════════════════════
 Data          files=${c.parse.files ?? 0} events=${c.events} books=${c.books} badLines=${c.parse.skipped ?? 0}
 Ticks         total=${c.ticks} warmup=${c.skippedWarmup} decision=${c.decisionTicks}
 Duration      ${fmt(m.durationHours)} h

 Equity        ${fmt(m.initialEquity)} → ${fmt(m.finalEquity)}  (${fmt(m.totalReturnPct)}%)
 Max drawdown  ${fmt(m.maxDrawdownPct)}%
 Sharpe (ann.) ${fmt(m.sharpe)}

 Signals       recs=${c.recs} fills=${c.fills} partials=${c.partials}
 Skipped       cooldown=${c.skippedCooldown} noBook=${c.skippedNoBook} noPosition=${c.skippedNoPosition} rejected=${c.rejectedFills}
 Trades        count=${m.tradeCount} closed=${m.closedCount} hitRate=${fmt(m.hitRate * 100, 1)}%
 Exits         signal=${c.exitsBySignal} maxHold=${c.exitsByMaxHold} endOfRun=${c.exitsAtEnd}${exitFailNote}
 P&L quality   profitFactor=${fmt(m.profitFactor)} avgWin=${fmt(m.avgWin)} avgLoss=${fmt(m.avgLoss)}
 Costs         fees=${fmt(m.feesPaid)} avgSlippage=${fmt(m.avgSlippageBps, 1)} bps
 Exit cost     avgExitSlippage=${fmt(avgExitSlipBps, 1)} bps  (forced exits pay the spread)
══════════════════════════════════════════════════════════════════
NOTE: taker-only fill model against recorded depth — treat results as
an upper bound on realizable edge (no queue/maker fills, no impact).
${exitWarning}`);

if (args.report) {
  const out = path.resolve(String(args.report));
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, JSON.stringify(report, null, 2));
  console.log(`[backtest] full report written: ${out}`);
}
