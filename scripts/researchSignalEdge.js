#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/researchSignalEdge.js — does the signal know anything?
// ═══════════════════════════════════════════════════════════════════════
//  RESEARCH TOOL. Not part of the gate, not used by live trading.
//
//  WHY THIS EXISTS
//
//  A 122h backtest produced 2058 recommendations and 54 fills. 2003 of the
//  rest were BUY_NO on markets where we held nothing. The engine maps
//  BUY_NO to "sell YES", which is a closing action, so a bearish view can
//  only be expressed by exiting — never by entering. Polymarket markets
//  have two tokens; buying NO is a perfectly ordinary opening trade. The
//  engine simply cannot take it.
//
//  Before building two-sided positions (which needs the NO orderbook
//  recorded, and days of new data), the question worth answering is
//  cheaper: do those discarded signals contain any directional
//  information at all?
//
//  WHAT THIS MEASURES
//
//  Forward returns, not P&L. For every recommendation the pipeline emits,
//  we note the mid price at that moment and look up the mid price N
//  minutes later, then score the move in the direction the signal asked
//  for. This deliberately ignores sizing, slippage and portfolio limits:
//  it isolates whether the signal points the right way. A signal with no
//  forward edge cannot be rescued by better execution.
//
//  The benchmark to beat is the round trip cost, which on recorded data
//  has been ~240 bps (109 bps entry + 131 bps exit). A mean forward move
//  below that is not tradable as a taker no matter how it is sized.
//
//  Usage:
//    node scripts/researchSignalEdge.js --data=data/recordings
//    node scripts/researchSignalEdge.js --data=data/recordings --horizons=15,30,60,120
//    SMART_MONEY_ENABLED=1 node scripts/researchSignalEdge.js --data=data/recordings
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG } from "../src/live/config/index.js";
import { SignalEngine } from "../src/live/signal_engine/index.js";
import { replayEvents } from "../src/backtest/replay.js";

const args = Object.fromEntries(
  process.argv.slice(2)
    .map(a => a.match(/^--([^=]+)(?:=(.*))?$/))
    .filter(Boolean)
    .map(m => [m[1], m[2] === undefined ? true : m[2]]),
);

const dataDir = args.data || "data/recordings";
const horizons = String(args.horizons || "15,30,60,120")
  .split(",").map(Number).filter(n => n > 0);
const warmup = Number(args.warmup || 30);
const ROUND_TRIP_BPS = Number(args["cost-bps"] || 240);
// Large enough that no position-sizing limit can suppress a signal.
const STUDY_EQUITY = Number(args.equity || 10_000_000);

const SILENT = {
  info: () => {}, warn: () => {}, debug: () => {}, error: () => {},
  decision: () => {}, trade: () => {}, errorEvent: () => {},
};

const engine = new SignalEngine(LIVE_CONFIG, SILENT);

// tokenId -> [{t, mid}] so a recommendation can be scored against the
// price that actually followed it.
const priceLog = new Map();
const recs = [];
// Every (token, tick) pair we could have looked at, signalled or not.
// Without this control the numbers are uninterpretable: a universe of
// markets decaying toward zero makes any "price will fall" signal look
// right, and 42% of recorded books sit below 0.10. Edge is what the
// signal adds ON TOP of that drift, not the drift itself.
const control = [];
const CONTROL_EVERY = Number(args["control-every"] || 20);   // sample 1 tick in N
const latestBooks = new Map();
const tokenMeta = new Map();
let ticks = 0;

function midAfter(tokenId, fromT, ms) {
  const series = priceLog.get(tokenId);
  if (!series) return null;
  const target = fromT + ms;
  let lo = 0, hi = series.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (series[m].t >= target) { idx = m; hi = m - 1; } else { lo = m + 1; }
  }
  if (idx === -1) return null;                 // recording ended first
  // Reject a match that is far past the target (gap in the tape).
  if (series[idx].t - target > 10 * 60_000) return null;
  return series[idx].mid;
}

console.log(`[research] replaying: ${dataDir}`);
console.log(`[research] smart money: ${LIVE_CONFIG.smartMoney.enabled ? "ON" : "off"}`);
console.log(`[research] price band: ${JSON.stringify(LIVE_CONFIG.signal.priceBand)}`);

for await (const evt of replayEvents(dataDir, {})) {
  switch (evt.type) {
    case "meta":
      for (const tok of evt.tokens || []) tokenMeta.set(tok.tokenId, tok);
      break;
    case "book": {
      if (!evt.book || typeof evt.book.midPrice !== "number") break;
      latestBooks.set(evt.tokenId, evt.book);
      const meta = tokenMeta.get(evt.tokenId) || {};
      engine.ingestOrderbook(evt.tokenId, evt.book, {
        question: meta.question, category: meta.category, adv: meta.adv,
      });
      let series = priceLog.get(evt.tokenId);
      if (!series) priceLog.set(evt.tokenId, series = []);
      if (typeof evt.t === "number") series.push({ t: evt.t, mid: evt.book.midPrice });
      break;
    }
    case "wallet_trades":
      if (Array.isArray(evt.trades)) engine.ingestWalletTrades(evt.trades);
      break;
    case "tick": {
      ticks++;
      if (ticks <= warmup) break;
      // Portfolio state is deliberately flat and the book deliberately
      // enormous. We are studying whether the signal points the right way,
      // so every sizing limit — Kelly, the 1% per-market cap, the dust
      // floor — must be prevented from silencing signals before they are
      // counted. At a realistic 1000 book those limits drop most of the
      // upper band, which would bias the sample toward cheap tokens and
      // tell us nothing about the signal itself.
      const out = engine.generateRecommendations(
        { equity: STUDY_EQUITY, currentDD: 0, grossExposure: 0, positions: {}, cbState: "closed" },
        evt.t,
      );
      for (const r of out) {
        const book = latestBooks.get(r.cid);
        if (!book) continue;
        recs.push({
          t: evt.t, tokenId: r.cid, dir: r.dir,
          mid: book.midPrice,
          spreadBps: book.midPrice > 0 ? (book.spread / book.midPrice) * 10_000 : 0,
          source: r.attr ? Object.keys(r.attr).join("+") : "engine",
        });
      }
      if (ticks % CONTROL_EVERY === 0) {
        for (const [tokenId, book] of latestBooks) {
          if (typeof book.midPrice === "number") {
            control.push({ t: evt.t, tokenId, mid: book.midPrice });
          }
        }
      }
      break;
    }
    default: break;
  }
}

console.log(`[research] ticks=${ticks} recommendations=${recs.length} control points=${control.length}\n`);

/**
 * Forward moves for a set of observations, signed in a given direction.
 * Returns the distribution, not just a mean, because most moves are
 * exactly zero: prices are quantised to a cent and a low-priced token
 * routinely does not budge for fifteen minutes. A "hit rate" that lumps
 * flat in with losses says almost nothing.
 */
function forwardMoves(rows, horizonMin, dirOf) {
  const up = [], down = [];
  let flat = 0;
  let absSum = 0, absN = 0;
  for (const r of rows) {
    const future = midAfter(r.tokenId, r.t, horizonMin * 60_000);
    if (future === null || !(r.mid > 0)) continue;
    const raw = (future - r.mid) / r.mid;
    const dir = dirOf ? dirOf(r) : r.dir;
    const v = dir === "BUY_YES" ? raw : -raw;
    // A binary contract pays the ABSOLUTE price change per contract, so
    // track that too. Relative return is dominated by cheap tokens, where
    // a single one-cent tick is a huge percentage.
    absSum += (dir === "BUY_YES" ? 1 : -1) * (future - r.mid);
    absN++;
    if (v > 1e-12) up.push(v);
    else if (v < -1e-12) down.push(v);
    else flat++;
  }
  const n = up.length + down.length + flat;
  if (n === 0) return null;
  const sum = up.reduce((a, v) => a + v, 0) + down.reduce((a, v) => a + v, 0);
  return {
    n,
    mean: sum / n,
    meanAbs: absN ? absSum / absN : 0,
    upPct: up.length / n,
    downPct: down.length / n,
    flatPct: flat / n,
  };
}

const bps = v => (v * 10_000).toFixed(0).padStart(6);

function row(label, rows, dirOf) {
  const first = forwardMoves(rows, horizons[0], dirOf);
  const cells = [`  ${label.padEnd(24)} n=${String(first ? first.n : 0).padStart(6)}`];
  let shown = false;
  for (const h of horizons) {
    const m = forwardMoves(rows, h, dirOf);
    if (!m) { cells.push(`${h}m: n/a`); continue; }
    shown = true;
    cells.push(
      `${String(h) + "m"}: ${bps(m.mean)}bps ` +
      `u/d/f ${(m.upPct * 100).toFixed(0)}/${(m.downPct * 100).toFixed(0)}/${(m.flatPct * 100).toFixed(0)}`
    );
  }
  console.log(shown ? cells.join("   ") : `  ${label.padEnd(24)} (no data)`);
}

console.log("Forward move in the signalled direction, mid to mid, BEFORE costs.");
console.log("u/d/f = percent of observations that moved up / down / not at all.");
console.log(`A taker round trip costs about ${ROUND_TRIP_BPS} bps.\n`);

// The control MUST be drawn from the same population as the signal.
// Signals only fire inside the price band; the raw recording is 42% below
// 0.10, where a single one-cent tick is a 50% relative move. Comparing
// in-band signals against an all-tokens control produced a spurious
// +600 bps "edge" that was entirely an artifact of that mismatch.
const band = LIVE_CONFIG.signal.priceBand;
const controlInBand = control.filter(c => c.mid >= band.min && c.mid <= band.max);

console.log("── CONTROL: same price band, no signal ──");
console.log(`  ${controlInBand.length} of ${control.length} control points are in band ` +
  `${band.min}-${band.max}; the rest cannot produce a signal at all.`);
row("always BUY_YES", controlInBand, () => "BUY_YES");
row("always BUY_NO", controlInBand, () => "BUY_NO");
console.log("");
console.log("These are the numbers a coin flip earns on the same markets at");
console.log("the same moments. The signal is worth something only if it beats");
console.log("the matching line by more than the round trip costs.\n");

console.log("── SIGNAL ──");
row("ALL", recs);
row("BUY_YES", recs.filter(r => r.dir === "BUY_YES"));
row("BUY_NO (discarded)", recs.filter(r => r.dir === "BUY_NO"));

console.log("");
console.log("── SIGNAL MINUS CONTROL (the actual edge) ──");
for (const dir of ["BUY_YES", "BUY_NO"]) {
  const sigRows = recs.filter(r => r.dir === dir);
  const cells = [`  ${dir.padEnd(24)}`];
  for (const h of horizons) {
    const sig = forwardMoves(sigRows, h);
    const ctl = forwardMoves(controlInBand, h, () => dir);
    if (!sig || !ctl) { cells.push(`${h}m: n/a`); continue; }
    const edge = sig.mean - ctl.mean;
    const verdict = edge * 10_000 > ROUND_TRIP_BPS ? "TRADABLE" : "no";
    cells.push(`${h}m: ${bps(edge)}bps ${verdict}`);
  }
  console.log(cells.join("   "));
}

console.log("");
const byBucket = new Map();
for (const r of recs) {
  const b = Math.floor(r.mid * 10) / 10;
  if (!byBucket.has(b)) byBucket.set(b, []);
  byBucket.get(b).push(r);
}
const ctlBucket = new Map();
for (const c of control) {
  const b = Math.floor(c.mid * 10) / 10;
  if (!ctlBucket.has(b)) ctlBucket.set(b, []);
  ctlBucket.get(b).push(c);
}
console.log("── EDGE OVER CONTROL, by entry price ──");
for (const b of [...byBucket.keys()].sort((a, x) => a - x)) {
  const rows = byBucket.get(b);
  const ctl = ctlBucket.get(b) || [];
  const cells = [`  px ${b.toFixed(1)}-${(b + 0.1).toFixed(1)}  n=${String(rows.length).padStart(6)}`];
  for (const h of horizons) {
    const sig = forwardMoves(rows, h);
    const ctlYes = forwardMoves(ctl, h, () => "BUY_YES");
    const ctlNo = forwardMoves(ctl, h, () => "BUY_NO");
    if (!sig || !ctlYes || !ctlNo) { cells.push(`${h}m: n/a`); continue; }
    const yesShare = rows.filter(r => r.dir === "BUY_YES").length / rows.length;
    const ctlMean = ctlYes.mean * yesShare + ctlNo.mean * (1 - yesShare);
    cells.push(`${h}m: ${bps(sig.mean - ctlMean)}bps`);
  }
  console.log(cells.join("   "));
}

const spreads = recs.map(r => r.spreadBps).filter(Number.isFinite).sort((a, b) => a - b);
if (spreads.length) {
  const med = spreads[Math.floor(spreads.length / 2)];
  const p25 = spreads[Math.floor(spreads.length * 0.25)];
  console.log("");
  console.log("── EXECUTION REALITY ──");
  console.log(`  spread at signal time: p25 ${p25.toFixed(0)} bps, median ${med.toFixed(0)} bps`);
  console.log(`  crossing it twice: ~${(med * 2).toFixed(0)} bps round trip`);
  console.log(`  every edge above must clear that number to be tradable as a taker`);
}

console.log("");
console.log("── IN ABSOLUTE TERMS (cents per contract, the unit that pays) ──");
{
  const spreadsAbs = recs
    .map(r => (r.spreadBps / 10_000) * r.mid)
    .filter(Number.isFinite).sort((a, b) => a - b);
  const medAbs = spreadsAbs.length ? spreadsAbs[Math.floor(spreadsAbs.length / 2)] : 0;
  console.log(`  median spread ${(medAbs * 100).toFixed(2)}c, round trip ~${(medAbs * 200).toFixed(2)}c per contract`);
  for (const dir of ["BUY_YES", "BUY_NO"]) {
    const sigRows = recs.filter(r => r.dir === dir);
    const cells = [`  ${dir.padEnd(10)}`];
    for (const h of horizons) {
      const sig = forwardMoves(sigRows, h);
      const ctl = forwardMoves(controlInBand, h, () => dir);
      if (!sig || !ctl) { cells.push(`${h}m: n/a`); continue; }
      const edgeCents = (sig.meanAbs - ctl.meanAbs) * 100;
      const verdict = edgeCents > medAbs * 200 ? " TRADABLE" : "";
      cells.push(`${h}m: ${edgeCents.toFixed(2)}c${verdict}`);
    }
    console.log(cells.join("   "));
  }
  console.log("  (edge over control, per contract, before costs)");
}

console.log("");
console.log("Caveat worth keeping in view: these observations are not");
console.log("independent. The same token is sampled every tick, so a single");
console.log("multi-hour price move contributes hundreds of rows. Treat the");
console.log("sign and the rough magnitude as informative, and the sample");
console.log("size as much smaller than n suggests.");
