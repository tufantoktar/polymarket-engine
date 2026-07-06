// ═══════════════════════════════════════════════════════════════════════
//  scripts/collect.js — V5.8 Phase 3: Market data collection CLI
// ═══════════════════════════════════════════════════════════════════════
//  Records live orderbooks to NDJSON. Read-only: uses public Gamma/CLOB
//  endpoints, never authenticates, never places orders.
//
//  Usage:
//    npm run collect                          # defaults: 10s interval, 20 tokens
//    npm run collect -- --interval=5 --tokens=30 --minutes=720
//    npm run collect -- --dir=data/recordings/session2 --trades
//
//  Stop anytime with Ctrl+C — shutdown is graceful (file flushed).
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG } from "../src/live/config/index.js";
import { getLogger } from "../src/live/logging/index.js";
import { PolymarketClient } from "../src/live/polymarketClient.js";
import { DataRecorder } from "../src/data/recorder.js";

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const log = getLogger(LIVE_CONFIG);

const overrides = {};
if (args.interval) overrides.intervalMs = Number(args.interval) * 1000;
if (args.tokens) overrides.maxTokens = Number(args.tokens);
if (args.dir) overrides.outDir = String(args.dir);
if (args.levels) overrides.bookLevels = Number(args.levels);
if (args.trades) overrides.recordTrades = true;

const client = new PolymarketClient(LIVE_CONFIG, log);
const recorder = new DataRecorder({ cfg: LIVE_CONFIG, client, logger: log, overrides });

const maxMinutes = args.minutes ? Number(args.minutes) : null;

let stopping = false;
async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[collect] stopping (${reason})…`);
  await recorder.stop();
  const s = recorder.stats;
  console.log(
    `[collect] done — ticks=${s.ticks} books=${s.booksWritten} trades=${s.tradesWritten} ` +
    `errors=${s.errors} bytes=${(s.bytesWritten / 1024).toFixed(1)}KB\n` +
    `[collect] data in: ${recorder.dataCfg.outDir}`
  );
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(
  `[collect] recording → ${recorder.dataCfg.outDir} ` +
  `(interval=${recorder.dataCfg.intervalMs / 1000}s tokens=${recorder.dataCfg.maxTokens}` +
  `${recorder.dataCfg.recordTrades ? " +trades" : ""})` +
  `${maxMinutes ? ` for ${maxMinutes} min` : " — Ctrl+C to stop"}`
);

await recorder.start();

if (maxMinutes) setTimeout(() => shutdown("time limit"), maxMinutes * 60_000);

// Periodic status line
setInterval(() => {
  if (stopping) return;
  const s = recorder.stats;
  const mins = ((Date.now() - s.startedAt) / 60_000).toFixed(1);
  console.log(
    `[collect] ${mins}min — ticks=${s.ticks} books=${s.booksWritten} errors=${s.errors} ` +
    `file=${s.currentFile}`
  );
}, 60_000).unref();
