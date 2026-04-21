#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/tradeHistory.js — simple CLI trade-history viewer
// ═══════════════════════════════════════════════════════════════════════
//  Reads logs/trades.jsonl and prints a summary table.
//
//  Usage:
//    node scripts/tradeHistory.js                    # last 50 trades
//    node scripts/tradeHistory.js --all              # full log
//    node scripts/tradeHistory.js --since=1h         # last 1 hour
//    node scripts/tradeHistory.js --event=live:placeOrder
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { LIVE_CONFIG } from "../src/live/config.js";

const args = process.argv.slice(2);
const parseArg = (name, def) => {
  const a = args.find(x => x.startsWith("--" + name + "="));
  if (!a) return def;
  return a.split("=")[1];
};
const flag = (name) => args.includes("--" + name);

const all = flag("all");
const eventFilter = parseArg("event", null);
const limit = Number(parseArg("limit", all ? Infinity : 50));
const sinceArg = parseArg("since", null);

function parseSince(s) {
  if (!s) return 0;
  const m = s.match(/^(\d+)([smhd])$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return Date.now() - n * mult;
}
const sinceMs = parseSince(sinceArg);

const file = path.join(LIVE_CONFIG.logging.dir, LIVE_CONFIG.logging.tradeLogFile);
if (!fs.existsSync(file)) {
  console.log(`No trade log yet at ${file}`);
  process.exit(0);
}

const raw = fs.readFileSync(file, "utf8").trim();
if (!raw) {
  console.log("Trade log is empty.");
  process.exit(0);
}

const entries = raw.split("\n").map(l => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

let rows = entries;
if (sinceMs > 0) rows = rows.filter(e => e.t >= sinceMs);
if (eventFilter) rows = rows.filter(e => e.msg === eventFilter);
rows = rows.slice(-limit);

// ─── Summary counts ───
const byEvent = {};
let paperCount = 0, liveCount = 0;
for (const r of entries) {
  byEvent[r.msg] = (byEvent[r.msg] || 0) + 1;
  if (r.mode === "paper") paperCount++; else liveCount++;
}

console.log("═══════════════════════════════════════════════════");
console.log("  Trade History — " + file);
console.log("═══════════════════════════════════════════════════");
console.log(`Total entries: ${entries.length}  (paper=${paperCount}, live=${liveCount})`);
console.log("");
console.log("By event type:");
for (const [k, v] of Object.entries(byEvent).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(30)} ${v}`);
}
console.log("");

// ─── Recent table ───
console.log(`Showing ${rows.length} entries${sinceArg ? ` since -${sinceArg}` : ""}${eventFilter ? ` (event=${eventFilter})` : ""}:`);
console.log("");
console.log("TIME".padEnd(26) + " MODE  EVENT".padEnd(32) + " DETAIL");
console.log("─".repeat(100));
for (const r of rows) {
  const time = (r.ts || "").slice(0, 19);
  const mode = (r.mode || "?").padEnd(5);
  const event = (r.msg || "").padEnd(24);
  // Compact detail
  let detail = "";
  if (r.order) {
    const o = r.order;
    detail = `${o.side || ""} ${o.size || ""}@${o.price || ""} tok=${(o.tokenId || "").slice(0, 10)}...`;
  } else if (r.orderId) {
    detail = `id=${r.orderId}`;
  }
  console.log(`${time.padEnd(20)} ${mode} ${event.padEnd(24)} ${detail}`);
}
