#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/researchMakerEdge.js — is the spread worth earning?
// ═══════════════════════════════════════════════════════════════════════
//  RESEARCH TOOL. Not part of the gate, not used by live trading.
//
//  THE QUESTION
//
//  Every measured signal died the same death: a taker round trip costs
//  about 367 bps on this book and no signal came close to clearing it.
//  The one lever bigger than any signal is to stop paying that spread and
//  start earning it. But a resting order is not free money. You are filled
//  precisely when someone wants to trade against you, which is
//  disproportionately when they know something or when the price is
//  already moving. That is adverse selection, and it is the whole
//  question. The spread is the payment for providing liquidity; adverse
//  selection is what that liquidity costs. Only the difference matters.
//
//  WHAT THIS MEASURES
//
//      resting BID  is filled when a taker SELL prints at or below it
//      resting ASK  is filled when a taker BUY  prints at or above it
//
//  then, in cents per contract:
//
//      earned  = future mid - fill price     (what the fill made)
//      drift   = same direction, random time (what direction alone made)
//      net     = earned - drift              (what liquidity provision made)
//
//  TWO CORRECTIONS THIS SCRIPT EXISTS TO GET RIGHT
//
//  1. The data-api feed returns the most recent global trades. Polling it
//     every 10s re-delivers the same trade roughly forty times. An earlier
//     version counted those as separate fills and inflated the sample by
//     that factor. Trades are deduplicated on their own identity here.
//
//  2. Those trades arrive one to five minutes stale. Matching them to
//     "the latest book we have seen" compares a trade to a book that did
//     not exist yet. Each trade is matched to the book current at ITS OWN
//     timestamp, and rejected if that book is too old to be evidence.
//
//  HONEST LIMITS — read before quoting any number
//
//   * Queue position is unknown. We assume front of queue and a full fill
//     on every print. That is the most optimistic assumption available.
//   * Books are ~10s snapshots, so the matched book is up to 10s old.
//   * Our order is assumed not to change anyone's behaviour.
//   * Only one leg is measured; a round trip pays adverse selection twice.
//
//  Usage:
//    node scripts/researchMakerEdge.js --data=data/recordings
//    node scripts/researchMakerEdge.js --data=data/recordings --horizons=1,5,15,30
//    node scripts/researchMakerEdge.js --data=data/recordings --max-book-age=30
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG } from "../src/live/config/index.js";
import { replayEvents } from "../src/backtest/replay.js";

const args = Object.fromEntries(
  process.argv.slice(2)
    .map(a => a.match(/^--([^=]+)(?:=(.*))?$/))
    .filter(Boolean)
    .map(m => [m[1], m[2] === undefined ? true : m[2]]),
);

const dataDir = args.data || "data/recordings";
const horizons = String(args.horizons || "1,5,15,30,60")
  .split(",").map(Number).filter(n => n > 0);
const band = LIVE_CONFIG.signal.priceBand;
const inBandOnly = args["all-prices"] ? false : true;

const bookLog = new Map();      // tokenId -> [{t, bid, ask, mid}] chronological
const uniqueTrades = new Map(); // dedup key -> trade
const control = [];
const CONTROL_EVERY = Number(args["control-every"] || 50);
let controlTick = 0;
let bookCount = 0, tradeRecords = 0, tradeEvents = 0;
const MAX_BOOK_AGE_MS = Number(args["max-book-age"] || 15) * 1000;

function bookAt(tokenId, t) {
  const log = bookLog.get(tokenId);
  if (!log || log.length === 0) return null;
  let lo = 0, hi = log.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (log[m].t <= t) { idx = m; lo = m + 1; } else { hi = m - 1; }
  }
  return idx === -1 ? null : log[idx];
}

function midAfter(tokenId, fromT, ms) {
  const log = bookLog.get(tokenId);
  if (!log) return null;
  const target = fromT + ms;
  let lo = 0, hi = log.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (log[m].t >= target) { idx = m; hi = m - 1; } else { lo = m + 1; }
  }
  if (idx === -1) return null;
  if (log[idx].t - target > 10 * 60_000) return null;
  return log[idx].mid;
}

console.log(`[maker] replaying: ${dataDir}`);
console.log(`[maker] price band: ${inBandOnly ? `${band.min}-${band.max}` : "all prices"}`);

// ── Pass 1: book history + distinct trades ─────────────────────────────
for await (const evt of replayEvents(dataDir, {})) {
  if (evt.type === "book") {
    const b = evt.book;
    if (!b || typeof b.midPrice !== "number" || typeof evt.t !== "number") continue;
    bookCount++;
    let log = bookLog.get(evt.tokenId);
    if (!log) bookLog.set(evt.tokenId, log = []);
    log.push({ t: evt.t, bid: b.bestBid, ask: b.bestAsk, mid: b.midPrice });
    controlTick++;
    if (controlTick % CONTROL_EVERY === 0
        && (!inBandOnly || (b.midPrice >= band.min && b.midPrice <= band.max))) {
      control.push({ tokenId: evt.tokenId, t: evt.t, mid: b.midPrice });
    }
    continue;
  }
  if (evt.type !== "wallet_trades" || !Array.isArray(evt.trades)) continue;
  tradeEvents++;
  for (const tr of evt.trades) {
    tradeRecords++;
    const key = `${tr.tokenId}|${tr.wallet}|${tr.side}|${tr.price}|${tr.size}|${tr.ts}`;
    if (!uniqueTrades.has(key)) uniqueTrades.set(key, tr);
  }
}

// ── Pass 2: match each distinct trade to the book at ITS OWN timestamp ──
const fills = [];
let noBook = 0, stale = 0, outOfBand = 0, notAtTouch = 0, degenerate = 0;

for (const tr of uniqueTrades.values()) {
  const t = Number(tr.ts);
  if (!Number.isFinite(t)) continue;
  const bk = bookAt(tr.tokenId, t);
  if (!bk) { noBook++; continue; }
  if (t - bk.t > MAX_BOOK_AGE_MS) { stale++; continue; }
  if (!(bk.bid > 0) || !(bk.ask > 0) || bk.ask <= bk.bid) { degenerate++; continue; }
  if (inBandOnly && (bk.mid < band.min || bk.mid > band.max)) { outOfBand++; continue; }

  const px = Number(tr.price);
  if (!Number.isFinite(px)) continue;

  if (tr.side === "SELL" && px <= bk.bid + 1e-9) {
    fills.push({ tokenId: tr.tokenId, t, side: "BID",
      fillPrice: bk.bid, mid: bk.mid, halfSpread: bk.mid - bk.bid, size: Number(tr.size) || 0 });
  } else if (tr.side === "BUY" && px >= bk.ask - 1e-9) {
    fills.push({ tokenId: tr.tokenId, t, side: "ASK",
      fillPrice: bk.ask, mid: bk.mid, halfSpread: bk.ask - bk.mid, size: Number(tr.size) || 0 });
  } else {
    notAtTouch++;
  }
}

console.log(`[maker] books=${bookCount} tradeEvents=${tradeEvents}`);
console.log(`[maker] trade records ${tradeRecords} -> distinct ${uniqueTrades.size} ` +
  `(${(tradeRecords / Math.max(1, uniqueTrades.size)).toFixed(1)}x duplication in the feed)`);
console.log(`[maker] passive fills ${fills.length}   rejected: noBook ${noBook}, ` +
  `stale>${MAX_BOOK_AGE_MS / 1000}s ${stale}, outOfBand ${outOfBand}, ` +
  `notAtTouch ${notAtTouch}, degenerate ${degenerate}\n`);

if (fills.length === 0) {
  console.log("No simulated fills survived the filters. Widen --max-book-age to");
  console.log("see whether staleness is the binding constraint, but treat any");
  console.log("result from a stale book with suspicion: the order could not");
  console.log("have been filled at a price the market had already left.");
  process.exit(0);
}

const c = v => (v * 100).toFixed(3);

function stats(rows, horizonMin) {
  const earned = [];
  for (const f of rows) {
    const future = midAfter(f.tokenId, f.t, horizonMin * 60_000);
    if (future === null) continue;
    const dirSign = f.side === "BID" ? 1 : -1;
    earned.push(dirSign * (future - f.fillPrice));
  }
  if (earned.length === 0) return null;
  const sorted = [...earned].sort((a, b) => a - b);
  return {
    n: earned.length,
    earned: earned.reduce((s, v) => s + v, 0) / earned.length,
    median: sorted[Math.floor(sorted.length / 2)],
    winRate: earned.filter(v => v > 0).length / earned.length,
  };
}

function driftFromMid(horizonMin, dirSign) {
  let sum = 0, n = 0;
  for (const cp of control) {
    const future = midAfter(cp.tokenId, cp.t, horizonMin * 60_000);
    if (future === null) continue;
    sum += dirSign * (future - cp.mid);
    n++;
  }
  return n ? { mean: sum / n, n } : null;
}

const avgHalfSpread = fills.reduce((s, f) => s + f.halfSpread, 0) / fills.length;
const nBid = fills.filter(f => f.side === "BID").length;
const nAsk = fills.length - nBid;

console.log("── SAMPLE ──");
console.log(`  ${fills.length} passive fills: ${nBid} on the bid, ${nAsk} on the ask`);
console.log(`  average half spread received: ${c(avgHalfSpread)}c\n`);

console.log("── RAW: what a passive fill earned (cents per contract) ──");
for (const label of ["ALL", "BID", "ASK"]) {
  const rows = label === "ALL" ? fills : fills.filter(f => f.side === label);
  const first = stats(rows, horizons[0]);
  const cells = [`  ${label.padEnd(4)} n=${String(first ? first.n : 0).padStart(5)}`];
  for (const h of horizons) {
    const s = stats(rows, h);
    cells.push(s ? `${h}m: ${c(s.earned).padStart(7)}c win ${(s.winRate * 100).toFixed(0)}%` : `${h}m: n/a`);
  }
  console.log(cells.join("  "));
}

console.log("");
console.log("── DRIFT CONTROL ──");
console.log(`  ${control.length} sampled moments, same markets and band.`);
console.log("  A fill inherits the drift of whatever direction it puts you in.");
console.log("  Selling into a falling market looks like skill and is not.");
for (const h of horizons) {
  const dLong = driftFromMid(h, 1);
  const dShort = driftFromMid(h, -1);
  if (!dLong || !dShort) continue;
  console.log(`  ${String(h).padStart(3)}m  long ${c(dLong.mean).padStart(7)}c   short ${c(dShort.mean).padStart(7)}c`);
}

console.log("");
console.log("── VERDICT: EARNED MINUS DRIFT (the real maker edge) ──");
console.log(`  Has to be positive, and ideally near the ${c(avgHalfSpread)}c half spread.\n`);
for (const h of horizons) {
  const bid = stats(fills.filter(f => f.side === "BID"), h);
  const ask = stats(fills.filter(f => f.side === "ASK"), h);
  const dLong = driftFromMid(h, 1);
  const dShort = driftFromMid(h, -1);
  if (!dLong || !dShort) continue;

  const bidNet = bid ? bid.earned - dLong.mean : null;
  const askNet = ask ? ask.earned - dShort.mean : null;
  const bidW = bid ? bid.n : 0, askW = ask ? ask.n : 0;
  const allNet = (bidW + askW)
    ? ((bidNet ?? 0) * bidW + (askNet ?? 0) * askW) / (bidW + askW)
    : null;
  if (allNet === null) continue;

  const verdict = allNet > 0
    ? "spread survives adverse selection"
    : "adverse selection eats the spread";
  console.log(
    `  ${String(h).padStart(3)}m  net ${c(allNet).padStart(7)}c   ` +
    `(bid ${bidNet === null ? "  n/a" : c(bidNet).padStart(7) + "c"}, ` +
    `ask ${askNet === null ? "  n/a" : c(askNet).padStart(7) + "c"})  -> ${verdict}`
  );
}

console.log("");
console.log("  Short horizons are the ones that matter. A maker turns inventory");
console.log("  quickly; holding a passive fill for an hour is a directional bet.");

console.log("");
const byBucket = new Map();
for (const f of fills) {
  const b = Math.floor(f.mid * 10) / 10;
  if (!byBucket.has(b)) byBucket.set(b, []);
  byBucket.get(b).push(f);
}
console.log("── BY PRICE (raw earned, not drift adjusted) ──");
for (const b of [...byBucket.keys()].sort((a, x) => a - x)) {
  const rows = byBucket.get(b);
  const cells = [`  px ${b.toFixed(1)}-${(b + 0.1).toFixed(1)} n=${String(rows.length).padStart(4)}`];
  for (const h of horizons) {
    const s = stats(rows, h);
    cells.push(s ? `${h}m: ${c(s.earned).padStart(7)}c` : `${h}m: n/a`);
  }
  console.log(cells.join("  "));
}

console.log("");
console.log("Assumptions that make this OPTIMISTIC: front of queue, full fill");
console.log("on every print, 10s book snapshots, no market impact from our own");
console.log("order, and one leg only. The real number is worse than this one.");
