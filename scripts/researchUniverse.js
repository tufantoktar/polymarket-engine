#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/researchUniverse.js — is there a tradable universe here?
// ═══════════════════════════════════════════════════════════════════════
//  RESEARCH TOOL. Reads public endpoints only. Places no orders.
//
//  WHY
//
//  Two measurements have now come back negative on the markets we track:
//  the signal carries no forward information, and passive quoting loses
//  to adverse selection at the horizons a maker cares about. Both were
//  measured on the same universe — the top thirty markets by 24h volume
//  with at least 48h to resolution — and that universe has a median
//  spread of 183 bps and roughly twenty buys for every sell.
//
//  Before concluding anything about the venue, it is worth asking whether
//  the universe is a property of Polymarket or a property of our filter.
//  A market with a 20 bps spread and two-sided flow is a completely
//  different proposition from one with a 183 bps spread and one-way
//  retail buying, and the current scanner would not distinguish them.
//
//  WHAT IT REPORTS
//
//  For a sample of active markets: price, spread, depth on each side, and
//  how those vary with volume rank and with time to resolution. Then the
//  subset that would actually be worth quoting — in band, tight, deep.
//
//  Usage:
//    node scripts/researchUniverse.js
//    node scripts/researchUniverse.js --limit=300 --sample=200
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG } from "../src/live/config/index.js";

const args = Object.fromEntries(
  process.argv.slice(2)
    .map(a => a.match(/^--([^=]+)(?:=(.*))?$/))
    .filter(Boolean)
    .map(m => [m[1], m[2] === undefined ? true : m[2]]),
);

const LIMIT = Number(args.limit || 500);
const SAMPLE = Number(args.sample || 200);
const CONCURRENCY = Number(args.concurrency || 8);
const band = LIVE_CONFIG.signal.priceBand;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseTokenIds(m) {
  try {
    const toks = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : m.tokens || [];
    if (!Array.isArray(toks) || toks.length === 0) return [];
    return toks.map(t => (typeof t === "string" ? t : t?.token_id)).filter(Boolean);
  } catch { return []; }
}

console.log("[universe] fetching active markets from Gamma…");
const res = await fetch(
  `${LIVE_CONFIG.clob.gammaHost}/markets?active=true&closed=false` +
  `&limit=${LIMIT}&order=volume24hr&ascending=false`
);
if (!res.ok) {
  console.error(`Gamma /markets failed: ${res.status}`);
  process.exit(1);
}
const markets = await res.json();
console.log(`[universe] ${markets.length} active markets returned\n`);

const candidates = [];
for (let rank = 0; rank < markets.length; rank++) {
  const m = markets[rank];
  const toks = parseTokenIds(m);
  if (toks.length === 0) continue;
  const hours = m.endDate ? (new Date(m.endDate).getTime() - Date.now()) / 3_600_000 : null;
  candidates.push({
    rank,
    tokenId: toks[0],
    noTokenId: toks[1] || null,
    question: m.question || "",
    vol24: Number(m.volume24hr ?? m.volume24Hr ?? 0),
    liquidity: Number(m.liquidity ?? m.liquidityNum ?? 0),
    hours,
  });
}

const sample = candidates.slice(0, SAMPLE);
console.log(`[universe] pulling orderbooks for ${sample.length} markets…`);

async function fetchBook(tokenId) {
  try {
    const r = await fetch(`${LIVE_CONFIG.clob.host}/book?token_id=${encodeURIComponent(tokenId)}`);
    if (!r.ok) return null;
    const raw = await r.json();
    const bids = (raw.bids || []).map(b => ({ p: Number(b.price), s: Number(b.size) }))
      .sort((a, b) => b.p - a.p);
    const asks = (raw.asks || []).map(a => ({ p: Number(a.price), s: Number(a.size) }))
      .sort((a, b) => a.p - b.p);
    if (!bids.length || !asks.length) return null;
    const bestBid = bids[0].p, bestAsk = asks[0].p;
    if (!(bestBid > 0) || !(bestAsk > 0) || bestAsk <= bestBid) return null;
    const mid = (bestBid + bestAsk) / 2;
    return {
      mid, bestBid, bestAsk,
      spreadBps: ((bestAsk - bestBid) / mid) * 10_000,
      spreadCents: (bestAsk - bestBid) * 100,
      bidDepth: bids.reduce((s, x) => s + x.p * x.s, 0),
      askDepth: asks.reduce((s, x) => s + x.p * x.s, 0),
      topBid: bestBid * bids[0].s,
      topAsk: bestAsk * asks[0].s,
    };
  } catch { return null; }
}

const rows = [];
for (let i = 0; i < sample.length; i += CONCURRENCY) {
  const chunk = sample.slice(i, i + CONCURRENCY);
  const books = await Promise.all(chunk.map(c => fetchBook(c.tokenId)));
  chunk.forEach((c, j) => { if (books[j]) rows.push({ ...c, ...books[j] }); });
  await sleep(120);
  if (i % 40 === 0) process.stdout.write(".");
}
console.log(`\n[universe] ${rows.length} books retrieved\n`);

if (rows.length === 0) { console.log("No books. Check connectivity."); process.exit(0); }

const pct = (a, b) => b ? (a / b * 100).toFixed(1) + "%" : "n/a";
const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

console.log("── THE WHOLE SAMPLE ──");
console.log(`  markets with a two-sided book: ${rows.length} of ${sample.length}`);
console.log(`  median spread: ${med(rows.map(r => r.spreadBps)).toFixed(0)} bps ` +
  `(${med(rows.map(r => r.spreadCents)).toFixed(2)} cents)`);
console.log(`  median top-of-book depth: bid $${med(rows.map(r => r.topBid)).toFixed(0)}, ` +
  `ask $${med(rows.map(r => r.topAsk)).toFixed(0)}`);
console.log(`  in price band ${band.min}-${band.max}: ` +
  `${pct(rows.filter(r => r.mid >= band.min && r.mid <= band.max).length, rows.length)}`);

console.log("");
console.log("── SPREAD DISTRIBUTION ──");
for (const [lo, hi] of [[0, 20], [20, 50], [50, 100], [100, 200], [200, 500], [500, Infinity]]) {
  const n = rows.filter(r => r.spreadBps >= lo && r.spreadBps < hi).length;
  const label = hi === Infinity ? `${lo}+ bps` : `${lo}-${hi} bps`;
  console.log(`  ${label.padEnd(14)} ${String(n).padStart(4)}  ${pct(n, rows.length).padStart(6)}  ` +
    "#".repeat(Math.round(n / rows.length * 40)));
}

console.log("");
console.log("── BY VOLUME RANK (does going deeper help?) ──");
for (const [lo, hi] of [[0, 25], [25, 50], [50, 100], [100, 200]]) {
  const sub = rows.filter(r => r.rank >= lo && r.rank < hi);
  if (!sub.length) continue;
  console.log(`  rank ${String(lo).padStart(3)}-${String(hi).padStart(3)}  n=${String(sub.length).padStart(3)}  ` +
    `median spread ${med(sub.map(r => r.spreadBps)).toFixed(0).padStart(4)} bps   ` +
    `median topBid $${med(sub.map(r => r.topBid)).toFixed(0).padStart(5)}   ` +
    `in band ${pct(sub.filter(r => r.mid >= band.min && r.mid <= band.max).length, sub.length)}`);
}

console.log("");
console.log("── BY TIME TO RESOLUTION ──");
for (const [lo, hi, label] of [[0, 24, "<1 day"], [24, 168, "1-7 days"],
                               [168, 720, "1-4 weeks"], [720, Infinity, "1 month+"]]) {
  const sub = rows.filter(r => r.hours !== null && r.hours >= lo && r.hours < hi);
  if (!sub.length) continue;
  console.log(`  ${label.padEnd(10)} n=${String(sub.length).padStart(3)}  ` +
    `median spread ${med(sub.map(r => r.spreadBps)).toFixed(0).padStart(4)} bps   ` +
    `in band ${pct(sub.filter(r => r.mid >= band.min && r.mid <= band.max).length, sub.length)}`);
}

console.log("");
console.log("── WORTH QUOTING? (in band, spread under 100 bps, $200+ each side) ──");
const good = rows.filter(r =>
  r.mid >= band.min && r.mid <= band.max &&
  r.spreadBps < 100 && r.topBid >= 200 && r.topAsk >= 200
).sort((a, b) => a.spreadBps - b.spreadBps);

console.log(`  ${good.length} of ${rows.length} sampled markets qualify (${pct(good.length, rows.length)})\n`);
for (const r of good.slice(0, 25)) {
  const q = r.question.length > 52 ? r.question.slice(0, 49) + "…" : r.question;
  console.log(`  ${String(Math.round(r.spreadBps)).padStart(4)} bps  mid ${r.mid.toFixed(3)}  ` +
    `bid $${String(Math.round(r.topBid)).padStart(6)}  ask $${String(Math.round(r.topAsk)).padStart(6)}  ` +
    `vol24 $${String(Math.round(r.vol24)).padStart(8)}  ${q}`);
}

console.log("");
console.log("── WHAT WE ACTUALLY TRACK TODAY (top 30 by volume) ──");
const tracked = rows.filter(r => r.rank < 30);
if (tracked.length) {
  console.log(`  median spread ${med(tracked.map(r => r.spreadBps)).toFixed(0)} bps, ` +
    `in band ${pct(tracked.filter(r => r.mid >= band.min && r.mid <= band.max).length, tracked.length)}, ` +
    `qualifying ${tracked.filter(r => good.includes(r)).length}`);
}

console.log("");
console.log("If the qualifying set is large, the negative results so far are a");
console.log("property of the selection filter and not of the venue. If it is");
console.log("near empty, this venue does not support the style of trading the");
console.log("engine was built for, and that is the finding.");
