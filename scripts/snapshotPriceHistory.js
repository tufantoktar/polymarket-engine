#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/snapshotPriceHistory.js — capture price history before it goes
// ═══════════════════════════════════════════════════════════════════════
//  PUBLIC READS ONLY. Places no orders, touches no live path.
//
//  WHY THIS EXISTS
//
//  CLOB /prices-history keeps roughly the last four to six weeks and
//  discards the rest. Of 2100 resolved markets spanning Oct 2025 to Aug
//  2026, only the most recent two months had any history at all; 1663
//  markets had none. Waiting does not accumulate this data, it destroys
//  it. Whatever is not captured inside the window is gone permanently.
//
//  Trimming is relative to NOW, not to when the market closed, so a
//  market captured days after it settles still carries weeks of history.
//  That is why the job runs often and captures early.
//
//  NEVER OVERWRITE
//
//  A second capture of the same market is always poorer than the first,
//  because more of the tail has since been trimmed. An existing archive
//  file is therefore left alone. Re-capturing would quietly degrade the
//  archive while looking like a refresh.
//
//  SELF-CONTAINED
//
//  Market metadata is stored beside the series. In two years Gamma may
//  no longer list these markets, and a bare array of numbers with no
//  question, no resolution and no event key cannot be analysed.
//
//  Usage:
//    node scripts/snapshotPriceHistory.js
//    node scripts/snapshotPriceHistory.js --days=30 --pages=120
//    node scripts/snapshotPriceHistory.js --dry-run
// ═══════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.match(/^--([^=]+)(?:=(.*))?$/))
    .filter(Boolean).map(m => [m[1], m[2] === undefined ? true : m[2]]),
);
const DAYS = Number(args.days || 21);
const MAX_PAGES = Number(args.pages || 100);
const ARCHIVE = args.out || "data/pricehistory";
const DRY = !!args["dry-run"];
const PAGE = 100;
// A market whose entire recorded history is under a day cannot supply a
// price at any horizon of a day or more, so storing it buys nothing and
// costs 400 MB a year. The cut is on history length, a property of the
// data, not on any outcome - it cannot bias a calibration measured at
// horizons of one day and up. Sub-day horizons are the microstructure
// hypotheses already killed.
const MIN_SPAN_DAYS = Number(args["min-span"] ?? 1);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch { /* retry */ }
    await sleep(400 * (i + 1));
  }
  return null;
}

function tokensOf(m) {
  try {
    const t = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : m.tokens || [];
    return t.map(x => typeof x === "string" ? x : x?.token_id).filter(Boolean);
  } catch { return []; }
}

const cutoff = Date.now() - DAYS * 86400_000;
console.log(`══════════ ADAY TARAMASI ══════════`);
console.log(`  son ${DAYS} günde kapanmış marketler, en fazla ${MAX_PAGES} sayfa`);
// Ordered by closedTime, not endDate. The endpoint serves at most ~2100
// closed markets, so the ordering decides WHICH 2100 are visible.
// Ordering by endDate returns the markets whose calendar end is furthest
// in the future and hid 96% of recent closures: 86 found against 2052
// actually there. The same mistake was fixed once in
// researchEventMispricing; the query was copied here without the lesson.
console.log(`  sıralama closedTime — endDate ile %96'sı görünmüyordu`);

const seen = new Map();
let pages = 0, lastPageHadFresh = false;
// The endpoint serves at most ~2100 closed markets. Ordered by closedTime
// that is about ten days at the current closure rate, so a ten day window
// sits right at the ceiling. If the sweep never reaches back past the
// cutoff, the far end of the window was truncated and markets were lost
// silently - which is the one failure this job exists to prevent.
let oldestSeen = Infinity;
for (let off = 0; pages < MAX_PAGES; off += PAGE, pages++) {
  const page = await getJson(
    `${GAMMA}/markets?closed=true&limit=${PAGE}&offset=${off}` +
    `&order=closedTime&ascending=false`);
  if (!Array.isArray(page) || page.length === 0) break;
  lastPageHadFresh = false;
  for (const m of page) {
    const closed = m.closedTime ? Date.parse(m.closedTime) : NaN;
    if (Number.isFinite(closed) && closed < oldestSeen) oldestSeen = closed;
    if (!Number.isFinite(closed) || closed < cutoff) continue;
    const tok = tokensOf(m)[0];
    if (!tok) continue;
    if (!seen.has(tok)) { seen.set(tok, { m, tok, closed }); lastPageHadFresh = true; }
  }
  if (pages % 10 === 9) process.stdout.write(".");
  await sleep(150);
}
console.log("");
console.log(`  ${pages} sayfa tarandı, pencerede ${seen.size} market bulundu`);

// If the final page still produced new in-window markets, the sweep was
// cut short and some are being missed. Say so rather than reporting a
// number that looks complete.
// The endpoint serves at most 2100 closed markets, which at the current
// closure rate is only about five hours. Asking whether the sweep reached
// the requested window would fire on every single run and become noise -
// the same mistake that buried the error log under 30k 404s.
//
// The operationally meaningful question is narrower: did anything close
// between the previous run and the oldest market this run could see? That
// gap is data lost for good, and it is the only condition worth an alarm.
const reachH = Number.isFinite(oldestSeen)
  ? (Date.now() - oldestSeen) / 3600_000 : 0;
let lastRunAt = null;
try {
  const lines = fs.readFileSync(path.join(ARCHIVE, "runs.ndjson"), "utf8")
    .trim().split("\n").filter(Boolean);
  if (lines.length) lastRunAt = Date.parse(JSON.parse(lines[lines.length - 1]).at);
} catch { /* first run */ }

console.log(`  tarama ${reachH.toFixed(1)} saat geriye ulaştı`);
if (lastRunAt && Number.isFinite(oldestSeen) && oldestSeen > lastRunAt) {
  const gapH = (oldestSeen - lastRunAt) / 3600_000;
  console.log(`  UYARI: önceki koşu ile bu taramanın ulaştığı nokta arasında`);
  console.log(`  ${gapH.toFixed(1)} saatlik boşluk var. O aralıkta kapanan marketler`);
  console.log(`  görülmedi ve geri getirilemez. Koşu sıklığını artır.`);
} else if (lastRunAt) {
  console.log(`  önceki koşudan beri boşluk yok`);
}
if (lastPageHadFresh && pages >= MAX_PAGES) {
  console.log(`  UYARI: son sayfada hâlâ yeni market vardı — tarama yetmedi.`);
  console.log(`  --pages=${MAX_PAGES * 2} ile tekrar çalıştır.`);
}

// ─── Capture ────────────────────────────────────────────────────────────
//  The whole market object is stored, not a chosen subset. Storage is
//  ~6 KB per market against a few hundred markets a month; guessing now
//  which field a study will need in two years is the expensive mistake,
//  not the disk.
const stats = { existing: 0, captured: 0, empty: 0, failed: 0, points: 0, tooShort: 0, knownShort: 0 };

// Markets deliberately not archived are remembered, otherwise every daily
// run refetches the same few thousand short-lived markets for ten days.
const skipFile = path.join(ARCHIVE, "skipped.ndjson");
const skipped = new Set();
if (fs.existsSync(skipFile)) {
  for (const line of fs.readFileSync(skipFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { skipped.add(JSON.parse(line).token); } catch { /* ignore */ }
  }
}
const newlySkipped = [];
const spans = [];
const queue = [...seen.values()];

function slotFor(c) {
  const mo = new Date(c.closed).toISOString().slice(0, 7);
  return { dir: path.join(ARCHIVE, mo), file: path.join(ARCHIVE, mo, `${c.tok}.json`) };
}

if (DRY) {
  let missing = 0;
  for (const c of queue) if (!fs.existsSync(slotFor(c).file)) missing++;
  console.log(`\n  DRY RUN: ${missing} market indirilecekti, ${queue.length - missing} zaten arşivde`);
  process.exit(0);
}

console.log(`\n══════════ ARŞİVLEME ══════════`);
const CONC = 4;
let idx = 0;
async function worker() {
  while (idx < queue.length) {
    const c = queue[idx++];
    const { dir, file } = slotFor(c);
    // Never overwrite: an older capture holds more history than a newer
    // one, because trimming has eaten the tail in the meantime.
    if (fs.existsSync(file)) { stats.existing++; continue; }
    if (skipped.has(c.tok)) { stats.knownShort++; continue; }

    const r = await getJson(
      `${CLOB}/prices-history?market=${c.tok}&interval=max&fidelity=60`);
    const hist = Array.isArray(r?.history) ? r.history.map(h => [h.t, h.p]) : [];
    if (hist.length === 0) {
      if (r === null) stats.failed++; else stats.empty++;
      await sleep(120);
      continue;
    }
    const ts = hist.map(h => h[0]);
    const spanDays = (Math.max(...ts) - Math.min(...ts)) / 86400;
    if (spanDays < MIN_SPAN_DAYS) {
      stats.tooShort++;
      newlySkipped.push({ token: c.tok, closedTime: c.m.closedTime,
        spanDays: Number(spanDays.toFixed(3)), reason: "span<min" });
      await sleep(120);
      continue;
    }
    spans.push(spanDays);
    stats.points += hist.length;

    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify({
      schema: 1,
      capturedAt: new Date().toISOString(),
      token: c.tok,
      closedTime: c.m.closedTime,
      spanDays: Number(spanDays.toFixed(2)),
      market: c.m,
      history: hist,
    }));
    stats.captured++;
    if (stats.captured % 25 === 0) process.stdout.write(".");
    await sleep(120);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log("");

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
if (newlySkipped.length) {
  await fsp.appendFile(skipFile,
    newlySkipped.map(x => JSON.stringify(x)).join("\n") + "\n");
}
console.log(`  yeni arşivlendi     ${stats.captured}`);
console.log(`  çok kısa, atlandı   ${stats.tooShort}  (<${MIN_SPAN_DAYS}g geçmiş)`);
console.log(`  daha önce atlanmış  ${stats.knownShort}`);
console.log(`  zaten arşivde       ${stats.existing}`);
console.log(`  geçmişi boş döndü   ${stats.empty}`);
console.log(`  istek başarısız     ${stats.failed}`);
if (spans.length) {
  const m = median(spans);
  console.log(`  medyan geçmiş uzunluğu ${m.toFixed(1)} gün ` +
    `(en uzun ${Math.max(...spans).toFixed(1)})`);
  for (const H of [30, 14, 7, 3, 1]) {
    const n = spans.filter(s => s >= H).length;
    console.log(`    ${String(H).padStart(2)}g ufkunu taşıyabilecek: ${n}/${spans.length}`);
  }
}

// A run log makes the archive auditable: when a study later asks why a
// month is thin, the answer is here rather than in someone's memory.
await fsp.mkdir(ARCHIVE, { recursive: true });
await fsp.appendFile(path.join(ARCHIVE, "runs.ndjson"), JSON.stringify({
  at: new Date().toISOString(), days: DAYS, pagesScanned: pages,
  candidates: seen.size, ...stats,
  medianSpanDays: spans.length ? Number(median(spans).toFixed(2)) : null,
}) + "\n");
console.log(`\n  koşu kaydı: ${path.join(ARCHIVE, "runs.ndjson")}`);
