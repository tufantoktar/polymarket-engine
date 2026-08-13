#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/researchSmartMoney.js — does past judgement predict future?
// ═══════════════════════════════════════════════════════════════════════
//  RESEARCH TOOL. Public reads only. Places no orders.
//
//  THE QUESTION, narrowly
//
//  Do wallets that showed good probability judgement in the past make
//  later trades that predict outcomes better than the Polymarket price
//  at the moment of the trade — out of sample?
//
//  Not who made the most money. Not who trades the most. Whether past
//  judgement predicts future judgement on unseen markets.
//
//  HOW A TRADE IS SCORED
//
//  A trade is a probability claim: buying YES at 0.51 asserts the truth
//  is above 0.51. Held to resolution the profit per contract is exactly
//  the distance between that claim and reality, measured against the
//  price the market offered. So the market baseline is ZERO by
//  construction — a wallet averaging zero knows what the market knows.
//  Only a mean above the cost of entering is worth anything.
//
//  WHAT WOULD MAKE THIS A LIE
//
//   * Scoring a wallet on markets that resolve after the cutoff, then
//     testing on the same period. The scoring function takes the cutoff
//     itself so this cannot be done by accident.
//   * Picking the top N after seeing the answer. Deciles are reported
//     across the whole distribution instead.
//   * Counting correlated wallets as independent evidence. Overlap is
//     measured and reported.
//   * Counting trades in one event as independent observations. Every
//     interval resamples events.
//   * Survivorship. Wallets are collected from the trade record itself,
//     so wallets that stopped trading are still present.
//
//  Usage:
//    node scripts/researchSmartMoney.js
//    node scripts/researchSmartMoney.js --markets=800 --refresh
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { tradePnl, scoreWalletsBefore, decileByScore, overlapMatrix }
  from "../src/research/walletScoring.js";
import { clusterBootstrapCI, walkForwardSplit, byCluster, makeRng }
  from "../src/research/calibration.js";
import { TradeDeduper } from "../src/data/tradeDedup.js";

const GAMMA = "https://gamma-api.polymarket.com";
const DATA = "https://data-api.polymarket.com";

const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.match(/^--([^=]+)(?:=(.*))?$/))
    .filter(Boolean).map(m => [m[1], m[2] === undefined ? true : m[2]]),
);

const CACHE = args.cache || "data/research/smartmoney";
const MARKET_CACHE = args["market-cache"] || "data/research/mispricing";
const WANT = Number(args.markets || 2100);
const MAX_PAGES = Number(args["max-pages"] || 4);
const CONCURRENCY = Number(args.concurrency || 6);
const REFRESH = !!args.refresh;
const MIN_TRADES = Number(args["min-trades"] || 10);
const MIN_EVENTS = Number(args["min-events"] || 3);
const COST_CENTS = Number(args["cost-cents"] || 1.0);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      if (r.status === 429) { await sleep(1000 * (i + 1)); continue; }
      return null;
    } catch { await sleep(300 * (i + 1)); }
  }
  return null;
}

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

await fsp.mkdir(CACHE, { recursive: true });
const marketsFile = path.join(MARKET_CACHE, "markets.json");
let rawMarkets;
if (fs.existsSync(marketsFile)) {
  rawMarkets = JSON.parse(await fsp.readFile(marketsFile, "utf8"));
  console.log(`[cache] ${rawMarkets.length} çözülmüş market (Faz 2 önbelleğinden)`);
} else {
  console.log("[fetch] çözülmüş marketler indiriliyor…");
  rawMarkets = [];
  for (let off = 0; off < 20000 && rawMarkets.length < WANT; off += 100) {
    const page = await getJson(`${GAMMA}/markets?closed=true&limit=100&offset=${off}&order=endDate&ascending=false`);
    if (!Array.isArray(page) || !page.length) break;
    rawMarkets.push(...page);
    process.stdout.write(".");
    await sleep(120);
  }
  console.log("");
  await fsp.mkdir(MARKET_CACHE, { recursive: true });
  await fsp.writeFile(marketsFile, JSON.stringify(rawMarkets));
}

const markets = [];
for (const m of rawMarkets) {
  const y = resolvedOutcome(m);
  if (y === null) continue;
  if (!m.conditionId) continue;
  const closed = Date.parse(m.closedTime ?? m.endDate);
  if (!Number.isFinite(closed)) continue;
  markets.push({
    id: m.conditionId,
    tokens: tokensOf(m),
    cluster: clusterKey(m),
    question: (m.question ?? "").slice(0, 60),
    resolvedAt: closed,
    y,
  });
}
console.log(`[markets] ${markets.length} market sonucu net, ${new Set(markets.map(m => m.cluster)).size} event`);

const tradesFile = path.join(CACHE, "trades.json");
let tradeCache = {};
if (!REFRESH && fs.existsSync(tradesFile)) {
  tradeCache = JSON.parse(await fsp.readFile(tradesFile, "utf8"));
}
const need = markets.filter(m => !tradeCache[m.id]);
console.log(`\n[fetch] ${need.length} market için işlem geçmişi (${markets.length - need.length} önbellekte)`);
console.log(`        market başına en fazla ${MAX_PAGES * 500} işlem`);

let truncated = 0;
for (let i = 0; i < need.length; i += CONCURRENCY) {
  const chunk = need.slice(i, i + CONCURRENCY);
  await Promise.all(chunk.map(async m => {
    const rows = [];
    for (let pg = 0; pg < MAX_PAGES; pg++) {
      const d = await getJson(`${DATA}/trades?market=${m.id}&limit=500&offset=${pg * 500}`);
      if (!Array.isArray(d) || !d.length) break;
      for (const t of d) {
        rows.push([t.proxyWallet, t.side, Number(t.price), Number(t.size),
                   Number(t.outcomeIndex), Number(t.timestamp), t.transactionHash]);
      }
      if (d.length < 500) break;
      if (pg === MAX_PAGES - 1) truncated++;
    }
    tradeCache[m.id] = rows;
  }));
  if (i % 120 === 0) {
    process.stdout.write(".");
    await fsp.writeFile(tradesFile, JSON.stringify(tradeCache));
  }
  await sleep(100);
}
await fsp.writeFile(tradesFile, JSON.stringify(tradeCache));
console.log("");

const dedup = new TradeDeduper({ ttlMs: Infinity, maxKeys: 5000000 });
const trades = [];
const dq = { rawRows: 0, dup: 0, badPnl: 0, noWallet: 0, markets: 0, truncatedMarkets: truncated };

for (const m of markets) {
  const rows = tradeCache[m.id];
  if (!rows?.length) continue;
  dq.markets++;
  const mapped = rows.map(([wallet, side, price, size, oi, ts, tx]) => ({
    transactionHash: tx, asset: `${m.id}:${oi}`, proxyWallet: wallet,
    side, price, size, timestamp: ts, _oi: oi, _ts: ts,
  }));
  const fresh = dedup.filterNew(mapped);
  dq.rawRows += rows.length;
  dq.dup += rows.length - fresh.length;

  for (const t of fresh) {
    if (!t.proxyWallet) { dq.noWallet++; continue; }
    const pnl = tradePnl({ side: t.side, price: t.price, outcomeIndex: t._oi }, m.y);
    if (pnl === null) { dq.badPnl++; continue; }
    trades.push({
      wallet: t.proxyWallet,
      marketId: m.id,
      cluster: m.cluster,
      side: t.side,
      outcomeIndex: t._oi,
      price: t.price,
      size: t.size,
      tradedAt: t._ts * 1000,
      resolvedAt: m.resolvedAt,
      pnl,
    });
  }
}

console.log("══════════ VERİ KALİTESİ ══════════");
console.log(`  işlem verisi olan market   ${dq.markets} / ${markets.length}`);
console.log(`  sayfa sınırına dayanan     ${dq.truncatedMarkets}  (en YENİ işlemler alınır, erken girişler eksik)`);
console.log(`  ham işlem satırı           ${dq.rawRows}`);
console.log(`  tekrar (dedup)             ${dq.dup}`);
console.log(`  fiyat/side geçersiz        ${dq.badPnl}`);
console.log(`  cüzdan yok                 ${dq.noWallet}`);
console.log(`  PUANLANAN İŞLEM            ${trades.length}`);
console.log(`  farklı cüzdan              ${new Set(trades.map(t => t.wallet)).size}`);
console.log(`  farklı event               ${byCluster(trades).size}`);

if (trades.length < 5000) {
  console.log("\n  Örneklem çok küçük. Sonuç üretmiyorum.");
  process.exit(0);
}

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const c2 = v => v === null || v === undefined ? "  n/a" : (v * 100).toFixed(2) + "c";

console.log(`\n  bütün işlemlerin ortalaması ${c2(mean(trades.map(t => t.pnl)))}  (sıfıra yakın olmalı — her işlemin karşı tarafı var)`);

const { early, late, cutoff } = walkForwardSplit(trades, { fraction: 0.6 });
console.log("\n══════════ ZAMAN BÖLÜMÜ ══════════");
console.log(`  kesim ${new Date(cutoff).toISOString().slice(0, 10)}`);
console.log(`  skorlama dönemi ${early.length} işlem, ${byCluster(early).size} event`);
console.log(`  test dönemi     ${late.length} işlem, ${byCluster(late).size} event`);

const scores = scoreWalletsBefore(trades, cutoff, { minTrades: MIN_TRADES, minEvents: MIN_EVENTS });
console.log(`\n  ${MIN_TRADES}+ işlem ve ${MIN_EVENTS}+ event şartını geçen cüzdan: ${scores.size}`);

const lateByWallet = new Map();
for (const t of late) {
  if (!lateByWallet.has(t.wallet)) lateByWallet.set(t.wallet, []);
  lateByWallet.get(t.wallet).push(t);
}
const tested = [...scores.keys()].filter(w => (lateByWallet.get(w)?.length ?? 0) >= 5);
console.log(`  bunlardan test döneminde 5+ işlemi olan: ${tested.length}`);

if (tested.length < 30) {
  console.log("\n  Test edilebilir cüzdan sayısı çok az. SMART MONEY: INSUFFICIENT DATA");
  process.exit(0);
}

const testable = new Map(tested.map(w => [w, scores.get(w)]));
const { deciles } = decileByScore(testable, "meanPnl");

console.log("\n\n══════════ DECILE: GEÇMİŞ SKOR -> GELECEK SONUÇ ══════════");
console.log("  Cüzdanlar SADECE kesim öncesi performansla sıralandı.");
console.log("  Sağdaki sütunlar kesim SONRASI işlemlerinden geliyor.\n");
console.log(`  ${"decile".padEnd(8)} ${"wallets".padStart(8)} ${"geçmiş".padStart(9)} ${"gelecek".padStart(9)} ${"işlem".padStart(7)} ${"event".padStart(7)} ${"%95 aralık".padStart(20)}`);

const decileRows = [];
for (let d = 9; d >= 0; d--) {
  const ws = deciles.get(d) ?? [];
  if (!ws.length) continue;
  const set = new Set(ws.map(x => x.wallet));
  const rows = late.filter(t => set.has(t.wallet));
  if (!rows.length) continue;
  const ci = clusterBootstrapCI(rows, r => mean(r.map(x => x.pnl)), { iterations: 400, seed: 17 });
  decileRows.push({ d, wallets: ws.length, past: mean(ws.map(x => x.meanPnl)), future: ci.point, n: rows.length, events: ci.clusters, lo: ci.lo, hi: ci.hi });
  console.log(`  ${("D" + (d + 1)).padEnd(8)} ${String(ws.length).padStart(8)} ${c2(mean(ws.map(x => x.meanPnl))).padStart(9)} ${c2(ci.point).padStart(9)} ${String(rows.length).padStart(7)} ${String(ci.clusters).padStart(7)} ${`[${c2(ci.lo)}, ${c2(ci.hi)}]`.padStart(20)}`);
}

console.log("\n\n══════════ KARŞILAŞTIRMA ══════════");
{
  const allLate = clusterBootstrapCI(late, r => mean(r.map(x => x.pnl)), { iterations: 400, seed: 5 });
  console.log(`  piyasa (tanım gereği)         ${c2(0)}`);
  console.log(`  test dönemindeki tüm işlemler ${c2(allLate.point)}  [${c2(allLate.lo)}, ${c2(allLate.hi)}]`);

  const rng = makeRng(99);
  const pool = tested;
  const draws = [];
  for (let i = 0; i < 200; i++) {
    const pick = new Set();
    const k = Math.max(1, Math.floor(pool.length / 10));
    while (pick.size < k) pick.add(pool[Math.floor(rng() * pool.length)]);
    const rows = late.filter(t => pick.has(t.wallet));
    if (rows.length) draws.push(mean(rows.map(x => x.pnl)));
  }
  draws.sort((a, b) => a - b);
  const q = f => draws[Math.min(draws.length - 1, Math.floor(f * draws.length))];
  console.log(`  rastgele cüzdan grubu         ${c2(q(0.5))}  [${c2(q(0.025))}, ${c2(q(0.975))}]  (aynı havuzdan, 200 çekiliş)`);

  const top = decileRows.find(r => r.d === 9);
  if (top) {
    const better = draws.filter(v => v >= top.future).length / draws.length;
    console.log(`  en iyi decile (D10)           ${c2(top.future)}  [${c2(top.lo)}, ${c2(top.hi)}]`);
    console.log(`  D10, rastgele grupların %${((1 - better) * 100).toFixed(0)}'inden iyi`);
  }
}

console.log("\n\n══════════ BAĞIMSIZLIK ══════════");
{
  const topSet = new Set((deciles.get(9) ?? []).map(x => x.wallet));
  const pairs = overlapMatrix(trades, topSet, { minShared: 5 });
  console.log(`  en iyi decile: ${topSet.size} cüzdan`);
  if (!pairs.length) console.log("  aralarında kayda değer örtüşme yok — ayrı görüşler gibi duruyorlar");
  else {
    console.log(`  ${pairs.length} çiftte 5+ ortak (market, taraf) var. En yüksek örtüşenler:`);
    for (const p of pairs.slice(0, 5)) {
      console.log(`    ${p.a.slice(0, 10)}… / ${p.b.slice(0, 10)}…  ortak ${p.shared}, benzerlik ${(p.jaccard * 100).toFixed(0)}%`);
    }
    const high = pairs.filter(p => p.jaccard > 0.5).length;
    if (high) {
      console.log(`  ${high} çift %50 üstü örtüşüyor — bunlar tek görüş olabilir,`);
      console.log(`  bağımsız kanıt sayısı göründüğünden az`);
    }
  }
}

console.log("\n\n══════════ KARAR ══════════");
{
  const top = decileRows.find(r => r.d === 9);
  const monotone = decileRows.length >= 5 ? (() => {
    const sorted = [...decileRows].sort((a, b) => a.d - b.d);
    let up = 0;
    for (let i = 1; i < sorted.length; i++) if (sorted[i].future > sorted[i - 1].future) up++;
    return up / (sorted.length - 1);
  })() : 0;

  console.log(`  test edilen cüzdan ${tested.length}, test dönemi event ${byCluster(late).size}`);
  if (top) {
    console.log(`  D10 gelecek performansı ${c2(top.future)}  [${c2(top.lo)}, ${c2(top.hi)}]`);
    console.log(`  işlem maliyeti          ${c2(COST_CENTS / 100)}`);
    console.log(`  decile sıralaması gelecekte de artıyor mu: ${(monotone * 100).toFixed(0)}% adımda evet`);
  }

  let verdict;
  if (!top || byCluster(late).size < 50) verdict = "INSUFFICIENT DATA";
  else if (top.lo === null || top.lo <= 0) verdict = "KILL";
  else if (top.lo * 100 > COST_CENTS && monotone >= 0.6) verdict = "PASS";
  else verdict = "WEAK";

  console.log(`\n  SMART MONEY: ${verdict}`);
  console.log("  " + {
    PASS: "geçmiş skoru yüksek cüzdanlar, görmedikleri marketlerde de piyasa fiyatını maliyeti aşacak kadar yeniyor",
    WEAK: "bir sinyal var ama ya güven aralığı maliyeti net aşmıyor ya da decile sıralaması gelecekte korunmuyor",
    KILL: "geçmiş performans gelecek performansı öngörmüyor; en iyi decile'ın güven aralığı sıfırı içeriyor",
    "INSUFFICIENT DATA": "test döneminde yeterli bağımsız event yok",
  }[verdict]);
}
