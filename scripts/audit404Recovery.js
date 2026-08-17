#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/audit404Recovery.js — are the /book 404s harmless?
// ═══════════════════════════════════════════════════════════════════════
//  READ ONLY. Touches no live path, places no orders.
//
//  The 404s are believed to be newly discovered markets whose orderbook
//  does not exist yet, curing themselves once liquidity arrives. If that
//  holds, the log level is wrong and 30k ERROR lines are burying the
//  real signals. But lowering the level also hides the one case that
//  would matter: a token that 404s and is then never recorded at all.
//  That is a silent hole in the dataset, and price history expires in
//  4-6 weeks, so a token missed is a token lost.
//
//  So: for every token that ever 404'd, did a book for it actually land?
//
//  Only 404s inside the recorded window are judged. A token that 404'd
//  before the first recording exists cannot be shown to be missing, and
//  counting it as missing would invent a problem.
// ═══════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const ERRLOG = "logs/errors.jsonl";
const RECDIR = "data/recordings";

async function eachLine(file, fn) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file), crlfDelay: Infinity,
  });
  for await (const line of rl) if (line) fn(line);
}

// ─── 404s from the error log ────────────────────────────────────────────
const four04 = new Map();     // token -> {first, last, n}
const otherStatus = new Map();
let errLines = 0;
await eachLine(ERRLOG, line => {
  errLines++;
  let o; try { o = JSON.parse(line); } catch { return; }
  const st = o.status;
  otherStatus.set(st, (otherStatus.get(st) || 0) + 1);
  if (st !== 404 || !o.tokenId) return;
  const t = Number(o.t);
  const e = four04.get(o.tokenId);
  if (!e) four04.set(o.tokenId, { first: t, last: t, n: 1 });
  else { e.n++; if (t < e.first) e.first = t; if (t > e.last) e.last = t; }
});

console.log("══════════ HATA LOGU ══════════");
console.log(`  satır ${errLines}`);
for (const [st, n] of [...otherStatus].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  status ${String(st).padEnd(12)} ${String(n).padStart(7)}`);
}
console.log(`  404 alan farklı token ${four04.size}`);

// ─── First recorded book per token ──────────────────────────────────────
const firstBook = new Map();
const lastBook = new Map();
let recStart = Infinity, recEnd = 0, bookLines = 0;
const files = fs.readdirSync(RECDIR).filter(f => f.endsWith(".ndjson")).sort();
console.log(`\n  ${files.length} kayıt dosyası taranıyor...`);
for (const f of files) {
  await eachLine(path.join(RECDIR, f), line => {
    if (line.indexOf('"type":"book"') === -1) return;
    let o; try { o = JSON.parse(line); } catch { return; }
    if (!o.tokenId) return;
    bookLines++;
    const t = Number(o.t);
    if (t < recStart) recStart = t;
    if (t > recEnd) recEnd = t;
    const prev = firstBook.get(o.tokenId);
    if (prev === undefined || t < prev) firstBook.set(o.tokenId, t);
    const pl = lastBook.get(o.tokenId);
    if (pl === undefined || t > pl) lastBook.set(o.tokenId, t);
  });
}
console.log(`  book satırı ${bookLines}, farklı token ${firstBook.size}`);
console.log(`  kayıt penceresi ${new Date(recStart).toISOString()} -> ${new Date(recEnd).toISOString()}`);

// ─── Did each 404 token eventually produce a book? ──────────────────────
//  Three outcomes, and only one of them is a problem:
//    already  - book seen BEFORE the 404, so the market was live and the
//               404 was a transient blip, not a discovery
//    healed   - first book landed after the 404, which is the expected
//               new-market story
//    missing  - no book, ever
//
//  A token whose 404s run right up to the end of the recording window
//  may simply not have healed YET, so it is held out as undecided rather
//  than counted against the hypothesis.
const MARGIN_MS = 2 * 3600_000;
const lags = [];
const buckets = { already: 0, healed: 0, missing: [], undecided: 0, outside: 0 };

for (const [token, e] of four04) {
  if (e.last < recStart || e.first > recEnd) { buckets.outside++; continue; }
  const fb = firstBook.get(token);
  if (fb !== undefined && fb <= e.first) { buckets.already++; continue; }
  if (fb !== undefined) {
    buckets.healed++;
    lags.push(fb - e.first);
    continue;
  }
  if (e.last > recEnd - MARGIN_MS) { buckets.undecided++; continue; }
  buckets.missing.push({ token, ...e });
}

const q = (a, f) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
};
const mins = ms => (ms / 60000).toFixed(1) + "dk";

console.log("\n══════════ 404 ALAN TOKEN'LARIN AKIBETİ ══════════");
console.log(`  zaten kaydediliyordu (geçici)  ${buckets.already}`);
console.log(`  sonradan kaydedildi (iyileşti) ${buckets.healed}`);
console.log(`  HİÇ KAYDEDİLMEDİ               ${buckets.missing.length}`);
console.log(`  karar verilemedi (pencere sonu)${buckets.undecided}`);
console.log(`  kayıt penceresi dışında        ${buckets.outside}`);

if (lags.length) {
  console.log("\n  iyileşme süresi: " +
    `medyan ${mins(q(lags, 0.5))}, p90 ${mins(q(lags, 0.9))}, en uzun ${mins(Math.max(...lags))}`);
}

if (buckets.missing.length) {
  console.log("\n  KAYIP TOKEN'LAR (en çok 404 alan 15):");
  for (const m of buckets.missing.sort((a, b) => b.n - a.n).slice(0, 15)) {
    console.log(`    ${m.token.slice(0, 18)}...  ${String(m.n).padStart(5)} kez  ` +
      `${new Date(m.first).toISOString().slice(0, 16)} -> ${mins(m.last - m.first)}`);
  }
}

console.log("\n══════════ KARAR ══════════");
const judged = buckets.already + buckets.healed + buckets.missing.length;
if (buckets.missing.length === 0) {
  console.log("  Karar verilebilen her token sonunda kaydedilmiş.");
  console.log("  404 bir hata değil, keşif gecikmesi. Log seviyesi düşürülebilir.");
} else {
  const pct = (100 * buckets.missing.length / Math.max(1, judged)).toFixed(1);
  console.log(`  Karar verilen ${judged} token'ın ${buckets.missing.length}'i (%${pct}) hiç kaydedilmemiş.`);
  console.log("  Aşağıdaki ömür kırılımına bak: 404'ler son kayıttan SONRA");
  console.log("  yoğunlaşıyorsa bunlar seçildiklerinde zaten kapanmış");
  console.log("  marketlerdir, yani aynı olayın t=0 hali ve veri kaybı değil.");
  console.log("  Kayıtların ARASINDA yoğunlaşıyorsa gerçek bir boşluk vardır");
  console.log("  ve log seviyesi düşürülmeden önce kovalanmalıdır.");
}

// ─── Where in a token's life does the 404 fall? ─────────────────────────
//  "Already recorded" covers two very different situations. If the 404s
//  begin after the last book, the market ended and the recorder kept
//  polling a dead token: wasteful, not broken. If they fall between the
//  first and last book, the orderbook genuinely vanished and came back,
//  which is a gap in a market we were actively recording.
let endOfLife = 0, midLife = 0;
const midExamples = [];
for (const [token, e] of four04) {
  const fb = firstBook.get(token), lb = lastBook.get(token);
  if (fb === undefined || fb > e.first) continue;
  if (e.first >= lb) { endOfLife++; continue; }
  midLife++;
  if (midExamples.length < 10) {
    midExamples.push({ token, n: e.n, gapMin: (e.last - e.first) / 60000,
      afterFirstH: (e.first - fb) / 3600_000, beforeLastH: (lb - e.last) / 3600_000 });
  }
}
console.log("\n══════════ 404 ÖMRÜN NERESİNDE ══════════");
console.log(`  son kayıttan SONRA (market bitmiş, ölü token yoklanıyor) ${endOfLife}`);
console.log(`  kayıtların ARASINDA (kitap kaybolup geri gelmiş)         ${midLife}`);
if (midExamples.length) {
  console.log("\n  ara kesinti örnekleri:");
  for (const m of midExamples) {
    console.log(`    ${m.token.slice(0, 16)}...  ${String(m.n).padStart(4)} kez, ` +
      `${m.gapMin.toFixed(1)}dk sürmüş, ilk kayıttan ${m.afterFirstH.toFixed(1)}s sonra, ` +
      `son kayda ${m.beforeLastH.toFixed(1)}s kala`);
  }
}
