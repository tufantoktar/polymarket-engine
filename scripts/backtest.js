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
 P&L quality   profitFactor=${fmt(m.profitFactor)} avgWin=${fmt(m.avgWin)} avgLoss=${fmt(m.avgLoss)}
 Costs         fees=${fmt(m.feesPaid)} avgSlippage=${fmt(m.avgSlippageBps, 1)} bps
══════════════════════════════════════════════════════════════════
NOTE: taker-only fill model against recorded depth — treat results as
an upper bound on realizable edge (no queue/maker fills, no impact).
`);

if (args.report) {
  const out = path.resolve(String(args.report));
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, JSON.stringify(report, null, 2));
  console.log(`[backtest] full report written: ${out}`);
}
