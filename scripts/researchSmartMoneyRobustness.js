#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/researchSmartMoneyRobustness.js — can the KILL be trusted?
// ═══════════════════════════════════════════════════════════════════════
//  RESEARCH TOOL. Reads the cache written by researchSmartMoney.js.
//  Places no orders. Changes no scoring rule.
//
//  WHY A SEPARATE FILE
//
//  The original experiment is the record. Editing it to run a variant
//  would make the two indistinguishable afterwards, and "we changed the
//  dataset" would blur into "we changed the model". This file imports the
//  same modules, reads the same cache, and applies the same cutoff,
//  eligibility rules, scoring formula and decile construction. The only
//  things that differ are stated explicitly below.
//
//  WHAT COULD HAVE MANUFACTURED THE NEGATIVE
//
//  1. Incomplete coverage. 242 markets hit the pagination ceiling, and
//     the endpoint returns the MOST RECENT trades. If skilled wallets
//     enter early, exactly their trades are the ones missing, and the
//     experiment would be blind to the effect it was looking for.
//
//  2. False precision. Trades inside one event are not independent
//     observations. The original already resampled events rather than
//     rows, but at 400 iterations; intervals that decide a hypothesis
//     deserve more, and the row-resampled interval is shown alongside so
//     the size of the mistake is visible rather than asserted.
//
//  Neither check is an attempt to rescue the hypothesis. If the negative
//  survives both, it is a real answer.
//
//  Usage:
//    node scripts/researchSmartMoneyRobustness.js
//    node scripts/researchSmartMoneyRobustness.js --iterations=5000 --seed=1
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { tradePnl, scoreWalletsBefore, decileByScore, overlapMatrix }
  from "../src/research/walletScoring.js";
import { clusterBootstrapCI, walkForwardSplit, byCluster, makeRng }
  from "../src/research/calibration.js";
import { TradeDeduper } from "../src/data/tradeDedup.js";

const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.match(/^--([^=]+)(?:=(.*))?$/))
    .filter(Boolean).map(m => [m[1], m[2] === undefined ? true : m[2]]),
);

// ── Held identical to the original experiment ──────────────────────────
const MIN_TRADES = 10;
const MIN_EVENTS = 3;
const MIN_TEST_TRADES = 5;
const SPLIT_FRACTION = 0.6;
const MAX_PAGES = 4;
const PAGE = 500;
const COST_CENTS = 1.0;

// ── The only knobs this file introduces ────────────────────────────────
const ITERATIONS = Number(args.iterations || 5000);
const SEED = Number(args.seed || 20260813);
const OVERLAP_THRESHOLD = 0.5;          // fixed by the brief, not tuned

const CACHE = args.cache || "data/research/smartmoney";
const MARKET_CACHE = args["market-cache"] || "data/research/mispricing";

const marketsFile = path.join(MARKET_CACHE, "markets.json");
const tradesFile = path.join(CACHE, "trades.json");
for (const f of [marketsFile, tradesFile]) {
  if (!fs.existsSync(f)) {
    console.error(`önbellek yok: ${f}\nÖnce scripts/researchSmartMoney.js çalıştırılmalı.`);
    process.exit(1);
  }
}

const rawMarkets = JSON.parse(await fsp.readFile(marketsFile, "utf8"));
const tradeCache = JSON.parse(await fsp.readFile(tradesFile, "utf8"));

function tokensOf(m) {
  try {
    const t = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : m.tokens || [];
    return t.map(x => typeof x === "string" ? x : x?.token_id).filter(Boolean);
  } catch { return []; }
}
function resolvedOutcome(m) {
  try {
    const pr = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
    if (!Array.isArray(pr) || pr.length < 2) return null;
    const yes = Number(pr[0]), no = Number(pr[1]);
    if (!Number.isFinite(yes) || !Number.isFinite(no)) return null;
    const TOL = 0.01;
    if (yes >= 1 - TOL && no <= TOL) return 1;
    if (yes <= TOL && no >= 1 - TOL) return 0;
    return null;
  } catch { return null; }
}
function clusterKey(m) {
  if (Array.isArray(m.events) && m.events[0]?.id) return `ev:${m.events[0].id}`;
  if (m.eventSlug) return `slug:${m.eventSlug}`;
  if (Array.isArray(m.events) && m.events[0]?.slug) return `slug:${m.events[0].slug}`;
  return `mkt:${m.conditionId ?? m.id}`;
}

/**
 * Coverage of a market's trade history, inferred from the cache.
 *
 * The fetch loop stopped either because a page came back short — meaning
 * the history was exhausted — or because it ran out of pages. So a row
 * count below the ceiling means we have everything, and a count at the
 * ceiling means we have only the most recent slice.
 *
 * A market with exactly 2000 trades is indistinguishable from a truncated
 * one and is classed PARTIAL. That is the conservative direction: it
 * shrinks the complete set rather than contaminating it.
 */
const CEILING = MAX_PAGES * PAGE;
function coverageOf(rows) {
  if (!rows || rows.length === 0) return "UNKNOWN";
  return rows.length >= CEILING ? "PARTIAL" : "COMPLETE";
}

const markets = [];
for (const m of rawMarkets) {
  const y = resolvedOutcome(m);
  if (y === null || !m.conditionId) continue;
  const closed = Date.parse(m.closedTime ?? m.endDate);
  if (!Number.isFinite(closed)) continue;
  markets.push({ id: m.conditionId, cluster: clusterKey(m), resolvedAt: closed, y });
}

const dedup = new TradeDeduper({ ttlMs: Infinity, maxKeys: 5000000 });
const allTrades = [];
const cov = { COMPLETE: 0, PARTIAL: 0, UNKNOWN: 0 };

for (const m of markets) {
  const rows = tradeCache[m.id];
  const c = coverageOf(rows);
  cov[c]++;
  if (c === "UNKNOWN") continue;
  const mapped = rows.map(([wallet, side, price, size, oi, ts, tx]) => ({
    transactionHash: tx, asset: `${m.id}:${oi}`, proxyWallet: wallet,
    side, price, size, timestamp: ts, _oi: oi, _ts: ts,
  }));
  for (const t of dedup.filterNew(mapped)) {
    if (!t.proxyWallet) continue;
    const pnl = tradePnl({ side: t.side, price: t.price, outcomeIndex: t._oi }, m.y);
    if (pnl === null) continue;
    allTrades.push({
      wallet: t.proxyWallet, marketId: m.id, cluster: m.cluster,
      side: t.side, outcomeIndex: t._oi, price: t.price,
      tradedAt: t._ts * 1000, resolvedAt: m.resolvedAt, pnl,
      coverage: c,
    });
  }
}

const completeTrades = allTrades.filter(t => t.coverage === "COMPLETE");

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const c2 = v => (v === null || v === undefined || !Number.isFinite(v)) ? "  n/a" : (v * 100).toFixed(2) + "c";

// The cutoff is computed ONCE, on the full dataset, and reused. Letting
// each dataset pick its own split date would change two things at once
// and make the comparison meaningless.
const { cutoff } = walkForwardSplit(allTrades, { fraction: SPLIT_FRACTION });

console.log("══════════ KAPSAM SINIFLANDIRMASI ══════════");
console.log(`  çözülmüş market            ${markets.length}`);
console.log(`  COMPLETE (tam geçmiş)      ${cov.COMPLETE}`);
console.log(`  PARTIAL  (sayfa sınırı)    ${cov.PARTIAL}   <- yalnızca en yeni ${CEILING} işlem`);
console.log(`  UNKNOWN  (işlem yok)       ${cov.UNKNOWN}`);
console.log(`\n  Sınıflandırma satır sayısından çıkarılıyor: tavana dayanan`);
console.log(`  market kesilmiş sayılır. Tam ${CEILING} işlemi olan bir market`);
console.log(`  de PARTIAL sayılır — temiz kümeyi kirletmektense küçültmek yeğ.`);

function rowBootstrapCI(rows, statistic, { iterations, seed }) {
  if (rows.length < 2) return { point: statistic(rows), lo: null, hi: null };
  const rng = makeRng(seed);
  const stats = [];
  for (let i = 0; i < iterations; i++) {
    const s = new Array(rows.length);
    for (let j = 0; j < rows.length; j++) s[j] = rows[(rng() * rows.length) | 0];
    const v = statistic(s);
    if (Number.isFinite(v)) stats.push(v);
  }
  stats.sort((a, b) => a - b);
  const q = f => stats[Math.min(stats.length - 1, Math.max(0, (f * stats.length) | 0))];
  return { point: statistic(rows), lo: q(0.025), hi: q(0.975) };
}

const meanPnl = rows => mean(rows.map(x => x.pnl));

/**
 * Event-clustered interval for a MEAN, without materialising samples.
 *
 * The generic bootstrap copies every row of every resampled cluster on
 * each iteration. For a mean that work is wasted: the mean of a
 * resampled set is the sum of the chosen clusters' sums over the sum of
 * their counts. Precomputing (sum, count) per cluster turns 24,000 array
 * pushes per iteration into 200 additions, and the answer is identical —
 * not an approximation.
 */
function fastClusterMeanCI(rows, { iterations, seed }) {
  const agg = new Map();
  for (const r of rows) {
    const k = r.cluster ?? "__none__";
    let a = agg.get(k);
    if (!a) agg.set(k, a = { s: 0, n: 0 });
    a.s += r.pnl; a.n++;
  }
  const cls = [...agg.values()];
  const total = { s: 0, n: 0 };
  for (const c of cls) { total.s += c.s; total.n += c.n; }
  const point = total.n ? total.s / total.n : null;
  if (cls.length < 2) return { point, lo: null, hi: null, clusters: cls.length };

  const rng = makeRng(seed);
  const stats = new Float64Array(iterations);
  let k = 0;
  for (let i = 0; i < iterations; i++) {
    let s = 0, n = 0;
    for (let j = 0; j < cls.length; j++) {
      const c = cls[(rng() * cls.length) | 0];
      s += c.s; n += c.n;
    }
    if (n) stats[k++] = s / n;
  }
  const arr = Array.from(stats.subarray(0, k)).sort((a, b) => a - b);
  const q = f => arr[Math.min(arr.length - 1, Math.max(0, (f * arr.length) | 0))];
  return { point, lo: q(0.025), hi: q(0.975), clusters: cls.length, iterations: k };
}


function runExperiment(trades, label) {
  const late = trades.filter(t => t.resolvedAt >= cutoff);
  const early = trades.filter(t => t.resolvedAt < cutoff);

  const scores = scoreWalletsBefore(trades, cutoff,
    { minTrades: MIN_TRADES, minEvents: MIN_EVENTS });

  const lateByWallet = new Map();
  for (const t of late) {
    if (!lateByWallet.has(t.wallet)) lateByWallet.set(t.wallet, []);
    lateByWallet.get(t.wallet).push(t);
  }
  const tested = [...scores.keys()]
    .filter(w => (lateByWallet.get(w)?.length ?? 0) >= MIN_TEST_TRADES);

  const out = {
    label,
    trades: trades.length,
    wallets: new Set(trades.map(t => t.wallet)).size,
    trainEvents: byCluster(early).size,
    testEvents: byCluster(late).size,
    eligible: scores.size,
    tested: tested.length,
    deciles: [], top: null, monotone: null, random: null,
    late, scores, tested,
  };
  if (tested.length < 30) return out;

  const testable = new Map(tested.map(w => [w, scores.get(w)]));
  const { deciles } = decileByScore(testable, "meanPnl");

  for (let d = 9; d >= 0; d--) {
    const ws = deciles.get(d) ?? [];
    if (!ws.length) continue;
    const set = new Set(ws.map(x => x.wallet));
    const rows = late.filter(t => set.has(t.wallet));
    if (!rows.length) continue;
    const ci = fastClusterMeanCI(rows, { iterations: ITERATIONS, seed: SEED });
    const naive = rowBootstrapCI(rows, meanPnl, { iterations: 500, seed: SEED });
    out.deciles.push({
      d, wallets: ws.length, past: mean(ws.map(x => x.meanPnl)),
      future: ci.point, n: rows.length, events: ci.clusters,
      lo: ci.lo, hi: ci.hi, naiveLo: naive.lo, naiveHi: naive.hi,
    });
  }
  out.top = out.deciles.find(r => r.d === 9) ?? null;

  const sorted = [...out.deciles].sort((a, b) => a.d - b.d);
  let up = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].future > sorted[i - 1].future) up++;
  out.monotone = sorted.length > 1 ? up / (sorted.length - 1) : null;

  // Draw from the per-wallet index rather than rescanning every late
  // trade for each draw. A thousand draws over 441k rows is half a
  // billion lookups for a number that does not change.
  const rng = makeRng(SEED + 1);
  const k = Math.max(1, Math.floor(tested.length / 10));
  const draws = [];
  for (let i = 0; i < 1000; i++) {
    const pick = new Set();
    while (pick.size < k) pick.add(tested[(rng() * tested.length) | 0]);
    let sum = 0, n = 0;
    for (const w of pick) {
      const rows = lateByWallet.get(w);
      if (!rows) continue;
      for (const t of rows) { sum += t.pnl; n++; }
    }
    if (n) draws.push(sum / n);
  }
  draws.sort((a, b) => a - b);
  const q = f => draws[Math.min(draws.length - 1, (f * draws.length) | 0)];
  out.random = {
    n: draws.length, k,
    mean: mean(draws), median: q(0.5), lo: q(0.025), hi: q(0.975),
    percentileOfTop: out.top ? draws.filter(v => v < out.top.future).length / draws.length : null,
  };
  out.overallLate = fastClusterMeanCI(late, { iterations: ITERATIONS, seed: SEED + 2 });
  return out;
}

function printDeciles(r) {
  console.log(`  ${"decile".padEnd(7)} ${"wallets".padStart(8)} ${"geçmiş".padStart(9)} ${"gelecek".padStart(9)} ${"işlem".padStart(7)} ${"event".padStart(6)} ${"event-kümeli %95".padStart(20)} ${"satır-bootstrap".padStart(20)}`);
  for (const x of r.deciles) {
    console.log(`  ${("D" + (x.d + 1)).padEnd(7)} ${String(x.wallets).padStart(8)} ${c2(x.past).padStart(9)} ${c2(x.future).padStart(9)} ${String(x.n).padStart(7)} ${String(x.events).padStart(6)} ${`[${c2(x.lo)}, ${c2(x.hi)}]`.padStart(20)} ${`[${c2(x.naiveLo)}, ${c2(x.naiveHi)}]`.padStart(20)}`);
  }
}

console.log(`\n\n══════════ AYARLAR ══════════`);
console.log(`  bootstrap iterasyonu ${ITERATIONS}, seed ${SEED}`);
console.log(`  kesim (tam veriden, iki koşuda da aynı) ${new Date(cutoff).toISOString().slice(0, 10)}`);
console.log(`  cüzdan eşikleri: ${MIN_TRADES}+ işlem, ${MIN_EVENTS}+ event, test ${MIN_TEST_TRADES}+ işlem`);
console.log(`  bunların hiçbiri bu koşuda değiştirilmedi`);

const orig = runExperiment(allTrades, "ORİJİNAL");
const comp = runExperiment(completeTrades, "COMPLETE ONLY");

console.log(`\n\n══════════ 1. ORİJİNAL VERİ ══════════`);
printDeciles(orig);
console.log(`\n\n══════════ 2. YALNIZCA TAM KAPSAMLI MARKETLER ══════════`);
if (comp.tested < 30) console.log(`  test edilebilir cüzdan ${comp.tested} — sonuç üretilemiyor`);
else printDeciles(comp);

console.log(`\n\n══════════ FİLTRENİN MALİYETİ ══════════`);
const row = (k, a, b) => console.log(`  ${k.padEnd(26)} ${String(a).padStart(14)} ${String(b).padStart(16)}`);
console.log(`  ${"".padEnd(26)} ${"orijinal".padStart(14)} ${"complete only".padStart(16)}`);
row("işlem", orig.trades, comp.trades);
row("cüzdan", orig.wallets, comp.wallets);
row("skorlama dönemi event", orig.trainEvents, comp.trainEvents);
row("test dönemi event", orig.testEvents, comp.testEvents);
row("uygun cüzdan", orig.eligible, comp.eligible);
row("test edilen cüzdan", orig.tested, comp.tested);
if (orig.top && comp.top) {
  row("D10 gelecek", c2(orig.top.future), c2(comp.top.future));
  row("D10 event", orig.top.events, comp.top.events);
  row("D10 %95 alt", c2(orig.top.lo), c2(comp.top.lo));
  row("D10 %95 üst", c2(orig.top.hi), c2(comp.top.hi));
  row("decile sıralaması korunuyor", `${(orig.monotone * 100).toFixed(0)}%`, `${(comp.monotone * 100).toFixed(0)}%`);
  row("rastgele yüzdelik", `${(orig.random.percentileOfTop * 100).toFixed(0)}%`, `${(comp.random.percentileOfTop * 100).toFixed(0)}%`);
}

console.log(`\n\n══════════ ARALIKLARIN KARŞILAŞTIRMASI ══════════`);
console.log(`  Satır-bootstrap, aynı eventteki işlemleri bağımsız sayar ve`);
console.log(`  bu veride yanlıştır. Doğru olanla yan yana, hatanın boyutu:`);
for (const r of [orig, comp]) {
  if (!r.top) continue;
  const clusterW = r.top.hi - r.top.lo;
  const naiveW = (r.top.naiveHi ?? 0) - (r.top.naiveLo ?? 0);
  console.log(`  ${r.label.padEnd(15)} D10  event-kümeli genişlik ${c2(clusterW)}, satır bazlı ${c2(naiveW)}  -> ${naiveW > 0 ? (clusterW / naiveW).toFixed(1) : "?"}x`);
}

console.log(`\n\n══════════ RASTGELE CÜZDAN TABANI ══════════`);
for (const r of [orig, comp]) {
  if (!r.random) continue;
  console.log(`  ${r.label}`);
  console.log(`    ${r.random.n} çekiliş, her biri ${r.random.k} cüzdan, aynı havuzdan`);
  console.log(`    ortalama ${c2(r.random.mean)}  medyan ${c2(r.random.median)}  %95 [${c2(r.random.lo)}, ${c2(r.random.hi)}]`);
  if (r.top) {
    console.log(`    D10 ${c2(r.top.future)} -> rastgele grupların %${(r.random.percentileOfTop * 100).toFixed(0)}'inden iyi`);
    console.log(`    D10 eksi rastgele medyan: ${c2(r.top.future - r.random.median)}`);
  }
  console.log(`    piyasa tabanı (tanım gereği) ${c2(0)}`);
  if (r.overallLate) {
    console.log(`    test dönemindeki tüm işlemler ${c2(r.overallLate.point)} [${c2(r.overallLate.lo)}, ${c2(r.overallLate.hi)}]`);
  }
}

console.log(`\n\n══════════ CÜZDAN BAĞIMLILIĞI ══════════`);
{
  const testableOrig = new Map(orig.tested.map(w => [w, orig.scores.get(w)]));
  const d10 = decileByScore(testableOrig, "meanPnl").deciles.get(9) ?? [];
  const topWallets = new Set(d10.map(x => x.wallet));
  const pairs = overlapMatrix(allTrades, topWallets, { minShared: 5 });
  const sims = pairs.map(p => p.jaccard).sort((a, b) => a - b);
  console.log(`  D10 cüzdan sayısı             ${topWallets.size}`);
  console.log(`  5+ ortak pozisyonlu çift      ${pairs.length}`);
  if (sims.length) {
    console.log(`  en yüksek benzerlik           ${(sims[sims.length - 1] * 100).toFixed(0)}%`);
    console.log(`  medyan benzerlik (örtüşenler) ${(sims[(sims.length / 2) | 0] * 100).toFixed(0)}%`);
    console.log(`  %${OVERLAP_THRESHOLD * 100} üstü çift            ${pairs.filter(p => p.jaccard >= OVERLAP_THRESHOLD).length}`);
  }

  const parent = new Map();
  for (const w of topWallets) parent.set(w, w);
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  let merges = 0;
  for (const p of pairs) {
    if (p.jaccard < OVERLAP_THRESHOLD) continue;
    if (!parent.has(p.a) || !parent.has(p.b)) continue;
    const ra = find(p.a), rb = find(p.b);
    if (ra !== rb) { parent.set(rb, ra); merges++; }
  }
  if (merges === 0) {
    console.log(`\n  %${OVERLAP_THRESHOLD * 100} eşiğinde birleştirilecek çift yok`);
  } else {
    const keep = new Set(); const seenRoot = new Set();
    for (const w of topWallets) {
      const r = find(w);
      if (seenRoot.has(r)) continue;
      seenRoot.add(r); keep.add(w);
    }
    const rows = orig.late.filter(t => keep.has(t.wallet));
    const ci = fastClusterMeanCI(rows, { iterations: ITERATIONS, seed: SEED + 3 });
    console.log(`\n  %${OVERLAP_THRESHOLD * 100} üstü örtüşenler tek aktör sayıldı: ${topWallets.size} -> ${keep.size} cüzdan (${merges} birleştirme)`);
    console.log(`  D10 (birleştirilmiş) ${c2(ci.point)}  [${c2(ci.lo)}, ${c2(ci.hi)}]  ${ci.clusters} event`);
  }
}

console.log(`\n\n══════════ NİHAİ KARAR ══════════`);
{
  const primary = comp.tested >= 30 ? comp : orig;
  const which = comp.tested >= 30 ? "tam kapsamlı küme" : "orijinal küme (tam kapsamlı küme çok küçük)";
  const top = primary.top;

  console.log(`  birincil kanıt: ${which}`);
  if (!top) {
    console.log(`\n  SMART MONEY: INSUFFICIENT DATA`);
  } else {
    const beatsRandom = primary.random.percentileOfTop >= 0.95;
    const ciPositive = top.lo !== null && top.lo > 0;
    const clearsCost = top.lo !== null && top.lo * 100 > COST_CENTS;
    const persists = primary.monotone !== null && primary.monotone >= 0.6;
    const survivesCoverage = comp.tested >= 30 && comp.top && comp.top.future > 0;

    console.log(`  D10 gelecek edge          ${c2(top.future)}`);
    console.log(`  event-kümeli %95          [${c2(top.lo)}, ${c2(top.hi)}]  (${top.events} event)`);
    console.log(`  aralık sıfırın üstünde    ${ciPositive ? "evet" : "HAYIR"}`);
    console.log(`  maliyeti aşıyor           ${clearsCost ? "evet" : "HAYIR"}  (eşik ${c2(COST_CENTS / 100)})`);
    console.log(`  rastgeleyi anlamlı yener  ${beatsRandom ? "evet" : "HAYIR"}  (yüzdelik %${(primary.random.percentileOfTop * 100).toFixed(0)})`);
    console.log(`  decile sıralaması korunur ${persists ? "evet" : "HAYIR"}  (%${(primary.monotone * 100).toFixed(0)} adım)`);
    console.log(`  tam kapsamda da ayakta    ${survivesCoverage ? "evet" : "HAYIR"}`);

    const allPass = ciPositive && clearsCost && beatsRandom && persists && survivesCoverage;
    const verdict = allPass ? "PASS" : (top.future > 0 ? "WEAK" : "KILL");
    console.log(`\n  SMART MONEY: ${verdict}`);
    if (verdict === "KILL") {
      console.log(`  D10 gelecek performansı sıfır ya da altında ve güven aralığı`);
      console.log(`  ekonomik olarak anlamlı bir pozitif edge içermiyor. İki`);
      console.log(`  duyarlılık testi de sonucu değiştirmedi.`);
      console.log(`\n  Negatif D10'u "ters yönde strateji" diye okumak yeni bir`);
      console.log(`  hipotezdir ve kendi deneyini gerektirir; burada yapılmıyor.`);
    }
  }
}
