#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/researchEventMispricing.js — how good a forecaster is the market?
// ═══════════════════════════════════════════════════════════════════════
//  RESEARCH TOOL. Public reads only. Places no orders.
//
//  THE QUESTION
//
//  Of everything Polymarket prices at 0.60, does roughly 60% happen? If
//  yes, disagreeing with the market is not a strategy. If some class of
//  events is systematically mispriced by more than it costs to trade,
//  that is an edge that needs no speed and no microstructure.
//
//  This also fixes the baseline for everything after it. "A wallet is
//  smart" only means something relative to how smart the market already
//  is, so the market's own calibration has to be measured first.
//
//  SAMPLING — the decision that matters most
//
//  A market's price history has hundreds of hourly points. Using all of
//  them would count one market hundreds of times and let long-lived
//  markets drown out short ones. Instead each market contributes exactly
//  ONE observation per horizon: its price 30, 14, 7, 3 and 1 days before
//  resolution. Horizons are analysed separately, never pooled, because a
//  forecast a month out and one a day out are different claims.
//
//  INDEPENDENCE
//
//  Polymarket splits an event into one market per outcome. Those are not
//  independent: exactly one resolves YES by construction. Every interval
//  here comes from resampling EVENTS, not markets.
//
//  LEAKAGE
//
//  The price is read strictly before resolution. Anything at or after the
//  end date is discarded, and markets already pinned at 0 or 1 at the
//  horizon are reported separately rather than silently included.
//
//  Usage:
//    node scripts/researchEventMispricing.js
//    node scripts/researchEventMispricing.js --markets=1500 --refresh
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  brier, logLoss, baseRate, brierOfBaseRate, calibrationBuckets,
  expectedCalibrationError, clusterBootstrapCI, walkForwardSplit,
  economicEdge, byCluster,
} from "../src/research/calibration.js";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.match(/^--([^=]+)(?:=(.*))?$/))
    .filter(Boolean).map(m => [m[1], m[2] === undefined ? true : m[2]]),
);

const WANT = Number(args.markets || 1200);
const CACHE = args.cache || "data/research/mispricing";
const REFRESH = !!args.refresh;
const HORIZONS = [30, 14, 7, 3, 1];               // days before resolution
const CONCURRENCY = Number(args.concurrency || 6);

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

// ─── Category ───────────────────────────────────────────────────────────
//  Gamma's own labels are inconsistent, so map to a small fixed set and
//  keep everything that does not map as "Other" rather than guessing.
function categorise(m) {
  const hay = [
    m.category, ...(Array.isArray(m.tags) ? m.tags.map(t => t?.label ?? t) : []),
    m.question, m.slug,
  ].filter(Boolean).join(" ").toLowerCase();

  const has = (...ws) => ws.some(w => hay.includes(w));
  if (has("election", "president", "senate", "congress", "nominee", "primary",
          "governor", "parliament", "prime minister", "politic", "republican",
          "democrat", "vote", "cabinet", "attorney general")) return "Politics";
  if (has("bitcoin", "ethereum", "btc", "eth", "solana", "crypto", "token",
          "coin", "defi")) return "Crypto";
  if (has("nba", "nfl", "mlb", "nhl", "soccer", "football", "basketball",
          "tennis", "ufc", "premier league", "champions league", "world cup",
          "olympic", "cs2", "counter-strike", "dota", "esports", "vs.")) return "Sports";
  if (has("fed", "inflation", "cpi", "gdp", "interest rate", "recession",
          "unemployment", "jobs report", "fomc", "tariff", "economy")) return "Economics";
  if (has("openai", "gpt", "ai model", "artificial intelligence", "apple",
          "google", "tesla", "spacex", "nvidia", "chip", "launch", "iphone",
          "software", "tech")) return "Tech";
  return "Other";
}

// A market's cluster is its event. Gamma exposes this inconsistently, so
// try the explicit id, then the event slug, then fall back to the market
// itself — and report how many fell back, because a bad cluster key
// quietly restores the independence assumption we are trying to remove.
function clusterKey(m) {
  if (Array.isArray(m.events) && m.events.length && m.events[0]?.id) {
    return { key: `ev:${m.events[0].id}`, exact: true };
  }
  if (m.eventSlug) return { key: `slug:${m.eventSlug}`, exact: true };
  if (Array.isArray(m.events) && m.events[0]?.slug) {
    return { key: `slug:${m.events[0].slug}`, exact: true };
  }
  return { key: `mkt:${m.conditionId ?? m.id}`, exact: false };
}

function tokensOf(m) {
  try {
    const t = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : m.tokens || [];
    return t.map(x => typeof x === "string" ? x : x?.token_id).filter(Boolean);
  } catch { return []; }
}

// outcomes/outcomePrices are parallel arrays. The YES token is index 0,
// so its settlement value is outcomePrices[0]. Anything that is not
// cleanly 0 or 1 is a void or an unresolved market and is dropped.
function resolvedOutcome(m) {
  try {
    const prices = typeof m.outcomePrices === "string"
      ? JSON.parse(m.outcomePrices) : m.outcomePrices;
    if (!Array.isArray(prices) || prices.length < 2) return null;
    const yes = Number(prices[0]), no = Number(prices[1]);
    if (!Number.isFinite(yes) || !Number.isFinite(no)) return null;

    // Settlement values arrive as floats with rounding noise: a NO
    // resolution reads [4.4e-8, 0.99999996], not [0, 1]. An exact
    // comparison rejected 488 of 500 markets.
    //
    // Summing to one is NOT sufficient evidence of resolution. Markets
    // that closed without settling carry their last price, so [0.58,
    // 0.42] also sums to one and means nothing. A resolved market has
    // one side at essentially certainty.
    //
    // [0, 0] appears on old markets that were voided or never settled.
    const TOL = 0.01;
    if (yes >= 1 - TOL && no <= TOL) return 1;
    if (yes <= TOL && no >= 1 - TOL) return 0;
    return null;
  } catch { return null; }
}

// ─── Fetch ──────────────────────────────────────────────────────────────
await fsp.mkdir(CACHE, { recursive: true });
const marketsFile = path.join(CACHE, "markets.json");

let markets;
const cached = (!REFRESH && fs.existsSync(marketsFile))
  ? JSON.parse(await fsp.readFile(marketsFile, "utf8"))
  : null;

// The cache must not silently cap the sample. Asking for more markets
// than the cache holds has to trigger a fetch, otherwise --markets is a
// suggestion the script quietly ignores.
if (cached && cached.length >= WANT) {
  markets = cached;
  console.log(`[cache] ${markets.length} resolved market yüklendi (--refresh ile yenile)`);
} else {
  if (cached) {
    console.log(`[cache] ${cached.length} market var, ${WANT} istendi — devamı çekiliyor`);
  }
  console.log("[fetch] çözülmüş marketler indiriliyor…");
  markets = [];
  for (let off = 0; off < 20000 && markets.length < WANT; off += 100) {
    const page = await getJson(
      `${GAMMA}/markets?closed=true&limit=100&offset=${off}` +
      `&order=endDate&ascending=false`);
    if (!Array.isArray(page) || page.length === 0) break;
    markets.push(...page);
    process.stdout.write(".");
    await sleep(150);
  }
  console.log("");
  await fsp.writeFile(marketsFile, JSON.stringify(markets));
  console.log(`[fetch] ${markets.length} market indirildi ve önbelleğe alındı`);
}

// ─── Data quality, before any statistic ─────────────────────────────────
const dq = {
  raw: markets.length,
  noTokens: 0, noOutcome: 0, noEndDate: 0,
  usable: 0, inexactCluster: 0, earlyResolution: 0,
};

const usable = [];
for (const m of markets) {
  const toks = tokensOf(m);
  if (!toks.length) { dq.noTokens++; continue; }
  const y = resolvedOutcome(m);
  if (y === null) { dq.noOutcome++; continue; }
  // Anchor on when the market ACTUALLY closed, not on its scheduled end.
  // Ordering by endDate surfaces markets whose calendar end is years away
  // but which resolved early; anchoring on endDate then looks for a price
  // thirty days before a date the market never reached, and finds
  // nothing. closedTime is the real settlement moment.
  const closed = m.closedTime ? Date.parse(m.closedTime) : NaN;
  const scheduled = m.endDate ? Date.parse(m.endDate) : NaN;
  const end = Number.isFinite(closed) ? closed : scheduled;
  if (!Number.isFinite(end)) { dq.noEndDate++; continue; }
  if (Number.isFinite(closed) && Number.isFinite(scheduled)
      && Math.abs(closed - scheduled) > 30 * 86400_000) dq.earlyResolution++;
  const ck = clusterKey(m);
  if (!ck.exact) dq.inexactCluster++;
  usable.push({
    id: m.conditionId ?? m.id,
    token: toks[0],
    question: m.question ?? "",
    category: categorise(m),
    cluster: ck.key,
    resolvedAt: end,
    y,
    volume: Number(m.volumeNum ?? m.volume ?? 0),
  });
}
dq.usable = usable.length;

console.log("\n══════════ VERİ KALİTESİ ══════════");
console.log(`  ham market              ${dq.raw}`);
console.log(`  token yok               ${dq.noTokens}`);
console.log(`  sonuç net değil / void  ${dq.noOutcome}`);
console.log(`  kapanış zamanı yok      ${dq.noEndDate}`);
console.log(`  takvimden >30g erken çözülmüş ${dq.earlyResolution} ` +
  `(closedTime kullanılıyor, endDate değil)`);
console.log(`  KULLANILABİLİR          ${dq.usable}`);
console.log(`  event anahtarı belirsiz ${dq.inexactCluster} ` +
  `(bunlar tek başına küme sayılır — bağımsızlık varsayımını geri getirir)`);
const evCount = new Set(usable.map(u => u.cluster)).size;
console.log(`  farklı event            ${evCount}  (market/event = ${(usable.length / Math.max(1, evCount)).toFixed(1)})`);
if (dq.usable < 200) {
  console.log("\n  Örneklem çok küçük. İstatistik üretmek yerine duruyorum.");
  process.exit(0);
}

// ─── Price history ──────────────────────────────────────────────────────
const priceFile = path.join(CACHE, "prices.json");
let priceCache = {};
if (!REFRESH && fs.existsSync(priceFile)) {
  priceCache = JSON.parse(await fsp.readFile(priceFile, "utf8"));
}
const need = usable.filter(u => !priceCache[u.token]);
console.log(`\n[fetch] ${need.length} market için fiyat geçmişi gerekiyor ` +
  `(${usable.length - need.length} önbellekte)`);

for (let i = 0; i < need.length; i += CONCURRENCY) {
  const chunk = need.slice(i, i + CONCURRENCY);
  await Promise.all(chunk.map(async u => {
    const r = await getJson(`${CLOB}/prices-history?market=${u.token}&interval=max&fidelity=60`);
    priceCache[u.token] = Array.isArray(r?.history)
      ? r.history.map(h => [h.t, h.p])
      : [];
  }));
  if (i % 120 === 0) {
    process.stdout.write(".");
    await fsp.writeFile(priceFile, JSON.stringify(priceCache));
  }
  await sleep(120);
}
await fsp.writeFile(priceFile, JSON.stringify(priceCache));
console.log("");

// ─── Observations: one per market per horizon ───────────────────────────
//  Reads the last price at or before the horizon, and refuses anything
//  dated at or after resolution.
function priceAt(history, targetSec, resolutionSec) {
  if (!history?.length) return null;
  let best = null;
  for (const [t, p] of history) {
    if (t > targetSec) break;
    if (t >= resolutionSec) break;            // never look at or past resolution
    best = { t, p };
  }
  if (!best) return null;
  // A quote more than three days stale is not a forecast at that horizon.
  if (targetSec - best.t > 3 * 86400) return null;
  return best.p;
}

const obs = [];
const skip = { noHistory: 0, noPointAtHorizon: 0, pinned: 0 };
const diag = { histByYear: new Map(), noHistByYear: new Map(), spanDays: [] };

for (const u of usable) {
  const h = priceCache[u.token];
  const yr = new Date(u.resolvedAt).getUTCFullYear();
  if (!h?.length) {
    skip.noHistory++;
    diag.noHistByYear.set(yr, (diag.noHistByYear.get(yr) || 0) + 1);
    continue;
  }
  diag.histByYear.set(yr, (diag.histByYear.get(yr) || 0) + 1);
  diag.spanDays.push((h[h.length - 1][0] - h[0][0]) / 86400);
  const resSec = Math.floor(u.resolvedAt / 1000);
  for (const H of HORIZONS) {
    const p = priceAt(h, resSec - H * 86400, resSec);
    if (p === null || !Number.isFinite(p)) { skip.noPointAtHorizon++; continue; }
    if (p <= 0 || p >= 1) { skip.pinned++; continue; }
    obs.push({
      horizon: H, p, y: u.y, cluster: u.cluster, category: u.category,
      resolvedAt: u.resolvedAt, volume: u.volume, question: u.question,
    });
  }
}

console.log("══════════ ÖRNEKLEM ══════════");
console.log(`  gözlem            ${obs.length}   (market başına en fazla ${HORIZONS.length})`);
console.log(`  fiyat geçmişi yok ${skip.noHistory}`);
console.log(`  o ufukta veri yok ${skip.noPointAtHorizon}`);
console.log(`  0/1'e çakılı      ${skip.pinned}  (çözülmüş sayılır, hariç tutuldu)`);
{
  const med = a => { const x = [...a].sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : 0; };
  console.log(`\n  fiyat geçmişi olan marketlerin ömrü: medyan ${med(diag.spanDays).toFixed(1)} gün`);
  console.log(`  (bu, hangi ufukların doldurulabileceğini belirler)`);
  const years = [...new Set([...diag.histByYear.keys(), ...diag.noHistByYear.keys()])].sort();
  console.log(`  çözüm yılına göre  ${"geçmiş var".padStart(12)} ${"yok".padStart(6)}`);
  for (const y of years) {
    console.log(`    ${y}              ${String(diag.histByYear.get(y) || 0).padStart(10)} ` +
      `${String(diag.noHistByYear.get(y) || 0).padStart(6)}`);
  }
}

if (obs.length < 200) {
  console.log("\n  Gözlem çok az. Sonuç üretmiyorum.");
  process.exit(0);
}

// ─── Report helpers ─────────────────────────────────────────────────────
const f3 = v => v === null || v === undefined ? "   n/a" : v.toFixed(3);
const pctS = v => v === null || v === undefined ? "  n/a" : (v * 100).toFixed(1) + "%";

function line(label, rows, pad = 10) {
  if (!rows.length) return `  ${label.padEnd(pad)}      —`;
  const ci = clusterBootstrapCI(rows, r => baseRate(r), { iterations: 400, seed: 11 });
  const meanP = rows.reduce((s, r) => s + r.p, 0) / rows.length;
  const act = baseRate(rows);
  const err = meanP - act;
  return `  ${label.padEnd(pad)} ${String(rows.length).padStart(6)} ` +
    `${String(ci.clusters).padStart(7)} ${pctS(meanP).padStart(10)} ${pctS(act).padStart(11)} ` +
    `${((err * 100 >= 0 ? "+" : "") + (err * 100).toFixed(1) + "pt").padStart(9)}` +
    ` ${f3(brier(rows)).padStart(7)} ${f3(logLoss(rows)).padStart(8)}`;
}

const HEAD = `  ${"".padEnd(10)} ${"n".padStart(6)} ${"events".padStart(7)} ` +
  `${"Mean Prob".padStart(10)} ${"Actual YES".padStart(11)} ${"CalErr".padStart(9)} ` +
  `${"Brier".padStart(7)} ${"LogLoss".padStart(8)}`;

console.log("\n\n══════════ KALİBRASYON: UFKA GÖRE ══════════");
console.log("  Her market her ufukta tek gözlem. Ufuklar ayrı analiz edilir:");
console.log("  bir ay önceki tahmin ile bir gün öncekisi farklı iddialardır.\n");
console.log(HEAD);
for (const H of HORIZONS) {
  console.log(line(`${H}d`, obs.filter(o => o.horizon === H)));
}

const CATS = ["Politics", "Crypto", "Sports", "Economics", "Tech", "Other"];
console.log("\n\n══════════ KALİBRASYON: KATEGORİYE GÖRE (tüm ufuklar) ══════════\n");
console.log(HEAD);
for (const c of CATS) {
  console.log(line(c, obs.filter(o => o.category === c)));
}

console.log("\n\n══════════ KATEGORİ × UFUK (kalibrasyon hatası, puan) ══════════\n");
console.log(`  ${"".padEnd(10)}${HORIZONS.map(h => (h + "d").padStart(9)).join("")}`);
for (const c of CATS) {
  const cells = HORIZONS.map(H => {
    const sub = obs.filter(o => o.category === c && o.horizon === H);
    if (sub.length < 20) return `    n<20`;
    const meanP = sub.reduce((s, r) => s + r.p, 0) / sub.length;
    const e = (meanP - baseRate(sub)) * 100;
    return `${(e >= 0 ? "+" : "") + e.toFixed(1)}`.padStart(9);
  });
  console.log(`  ${c.padEnd(10)}${cells.join("")}`);
}

console.log("\n\n══════════ GÜVENİLİRLİK EĞRİSİ (tüm ufuklar) ══════════");
console.log("  Pozitif hata = piyasa fazla fiyatlamış, işlem yönü YES SAT\n");
console.log(`  ${"band".padEnd(12)} ${"n".padStart(6)} ${"events".padStart(7)} ` +
  `${"quoted".padStart(8)} ${"actual".padStart(8)} ${"error".padStart(8)}  net edge`);
for (const b of calibrationBuckets(obs)) {
  if (!b.n) continue;
  const ec = economicEdge(b);
  const tag = b.clusters < 15 ? "  (az event)" :
    ec.tradable ? `  ${ec.netCents.toFixed(1)}c  ${ec.direction}` : `  ${ec.netCents.toFixed(1)}c`;
  console.log(`  ${(b.lo.toFixed(2) + "-" + b.hi.toFixed(2)).padEnd(12)} ` +
    `${String(b.n).padStart(6)} ${String(b.clusters).padStart(7)} ` +
    `${pctS(b.meanP).padStart(8)} ${pctS(b.freq).padStart(8)} ` +
    `${((b.error * 100 >= 0 ? "+" : "") + (b.error * 100).toFixed(1) + "pt").padStart(8)}${tag}`);
}

console.log("\n\n══════════ PİYASA BİR TAHMİNCİ OLARAK ══════════");
{
  const ci = clusterBootstrapCI(obs, expectedCalibrationError, { iterations: 500, seed: 3 });
  console.log(`  beklenen kalibrasyon hatası  ${f3(ci.point)}  ` +
    `[${f3(ci.lo)}, ${f3(ci.hi)}]  (event-kümeli %95)`);
  console.log(`  Brier                        ${f3(brier(obs))}`);
  console.log(`  taban oranı Brier'i          ${f3(brierOfBaseRate(obs))}   <- aşılması gereken eşik`);
  const skill = 1 - brier(obs) / brierOfBaseRate(obs);
  console.log(`  beceri skoru                 ${f3(skill)}  (0 = taban oranı kadar, 1 = kusursuz)`);
  console.log(`  log loss                     ${f3(logLoss(obs))}`);
  console.log(`  bağımsız event               ${ci.clusters}   (satır ${obs.length})`);
}

console.log("\n\n══════════ ÖRNEKLEM DIŞI: ZAMANA GÖRE BÖLÜM ══════════");
console.log("  Rastgele bölmek zaman serisinde geçersiz — sonraki bir event");
console.log("  öncekini 'tahmin' etmiş olur. Kesim bir çözüm tarihidir.\n");
{
  const { early, late, cutoff } = walkForwardSplit(obs, { fraction: 0.6 });
  if (!late.length) console.log("  bölünecek kadar veri yok");
  else {
    console.log(`  kesim: ${new Date(cutoff).toISOString().slice(0, 10)}   ` +
      `erken ${early.length} satır / geç ${late.length} satır\n`);
    console.log(HEAD);
    console.log(line("erken", early));
    console.log(line("geç", late));

    console.log("\n  bandlarda kalıcılık (erken hata -> geç hata, puan):");
    const be = calibrationBuckets(early), bl = calibrationBuckets(late);
    let agree = 0, tested = 0;
    for (let i = 0; i < be.length; i++) {
      if (be[i].n < 30 || bl[i].n < 30) continue;
      tested++;
      const e1 = be[i].error * 100, e2 = bl[i].error * 100;
      if (Math.sign(e1) === Math.sign(e2)) agree++;
      console.log(`    ${be[i].lo.toFixed(2)}-${be[i].hi.toFixed(2)}  ` +
        `${(e1 >= 0 ? "+" : "") + e1.toFixed(1)}  ->  ${(e2 >= 0 ? "+" : "") + e2.toFixed(1)}` +
        `${Math.sign(e1) === Math.sign(e2) ? "   aynı yön" : "   yön DEĞİŞTİ"}`);
    }
    if (tested) {
      console.log(`\n    ${agree}/${tested} bandda yön korundu` +
        (agree === tested ? " — sapma kalıcı görünüyor"
         : agree <= tested / 2 ? " — sapma kalıcı DEĞİL, gürültü olabilir" : ""));
    }
  }
}

console.log("\n\n══════════ KARAR ══════════");
{
  const tradableBuckets = calibrationBuckets(obs)
    .filter(b => b.n >= 50 && b.clusters >= 15)
    .map(b => ({ b, ec: economicEdge(b) }))
    .filter(x => x.ec?.tradable);

  const eceCI = clusterBootstrapCI(obs, expectedCalibrationError, { iterations: 500, seed: 3 });
  const totalClusters = byCluster(obs).size;

  console.log(`  gözlem ${obs.length}, bağımsız event ${totalClusters}`);
  console.log(`  maliyeti aşan band sayısı: ${tradableBuckets.length}`);
  for (const { b, ec } of tradableBuckets) {
    console.log(`    ${b.lo.toFixed(2)}-${b.hi.toFixed(2)}  ` +
      `${(b.error * 100).toFixed(1)}pt gross, ${ec.netCents.toFixed(1)}c net, ` +
      `${b.clusters} event  ->  ${ec.direction}`);
  }

  let verdict;
  if (totalClusters < 100) verdict = "INSUFFICIENT DATA";
  else if (tradableBuckets.length === 0) verdict = "KILL";
  else if (tradableBuckets.some(x => x.b.clusters >= 50 && x.ec.netCents >= 2)) verdict = "PASS";
  else verdict = "WEAK";

  console.log(`\n  EVENT MISPRICING: ${verdict}`);
  const why = {
    PASS: "en az bir band, yeterli event sayısıyla ve net 2c üstü sapma gösteriyor",
    WEAK: "sapma var ama ya event sayısı ya da büyüklüğü zayıf; tek başına strateji kurulmaz",
    KILL: "hiçbir band işlem maliyetini aşmıyor; piyasa fiyatlarıyla oynamak para kazandırmaz",
    "INSUFFICIENT DATA": "bağımsız event sayısı sonuç çıkarmak için az",
  }[verdict];
  console.log(`  ${why}`);
  console.log(`\n  Not: kalibrasyon hatası ${f3(eceCI.point)} [${f3(eceCI.lo)}, ${f3(eceCI.hi)}]`);
  console.log(`  Aralık sıfırı içeriyorsa piyasa kalibre demektir.`);
}
