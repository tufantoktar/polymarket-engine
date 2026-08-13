#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/dedupeRecordings.js — clean an existing recording, in place-safe
// ═══════════════════════════════════════════════════════════════════════
//  Recordings written before the recorder deduplicated contain each
//  wallet trade roughly forty times. This writes a cleaned copy to a new
//  directory and reports what it removed and why.
//
//  It never modifies the source. A destructive cleanup of the only copy
//  of a dataset is not a step worth taking to save disk, and if the
//  dedup logic is ever found wrong the originals are still there.
//
//  Order-book snapshots are NOT deduplicated. Two consecutive books with
//  identical contents are a real observation — the market genuinely did
//  not move — and collapsing them would corrupt every time series.
//
//  Usage:
//    node scripts/dedupeRecordings.js --in=data/recordings --out=data/clean
//    node scripts/dedupeRecordings.js --in=data/recordings --dry-run
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { TradeDeduper } from "../src/data/tradeDedup.js";

const args = Object.fromEntries(
  process.argv.slice(2)
    .map(a => a.match(/^--([^=]+)(?:=(.*))?$/))
    .filter(Boolean)
    .map(m => [m[1], m[2] === undefined ? true : m[2]]),
);

const inDir = args.in || "data/recordings";
const outDir = args.out || "data/recordings-clean";
const dryRun = !!args["dry-run"];

if (!fs.existsSync(inDir)) {
  console.error(`girdi klasörü yok: ${inDir}`);
  process.exit(1);
}
if (!dryRun && path.resolve(inDir) === path.resolve(outDir)) {
  console.error("çıktı klasörü girdiyle aynı olamaz — orijinaller korunmalı");
  process.exit(1);
}

const files = (await fsp.readdir(inDir))
  .filter(f => f.endsWith(".ndjson"))
  .sort();

console.log(`girdi : ${inDir}  (${files.length} dosya)`);
console.log(`çıktı : ${dryRun ? "(dry run, yazılmıyor)" : outDir}`);

if (!dryRun) await fsp.mkdir(outDir, { recursive: true });

// One deduper for the whole pass: a trade re-delivered across an hourly
// file boundary must still be caught. Retention is generous for the same
// reason — file boundaries are not feed boundaries.
const deduper = new TradeDeduper({ ttlMs: 6 * 60 * 60_000, maxKeys: 2_000_000 });

const before = { lines: 0, tradeEvents: 0, tradeRows: 0, books: 0, ticks: 0, other: 0, bad: 0 };
const after = { lines: 0, tradeEvents: 0, tradeRows: 0 };

for (const f of files) {
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(inDir, f)),
    crlfDelay: Infinity,
  });
  const out = [];

  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    before.lines++;
    let o;
    try { o = JSON.parse(s); } catch { before.bad++; continue; }

    if (o?.type === "wallet_trades" && Array.isArray(o.trades)) {
      before.tradeEvents++;
      before.tradeRows += o.trades.length;
      // Older recordings have no tx field; tradeKey falls back to
      // attributes and reports the weaker identity in stats.
      const fresh = deduper.filterNew(
        o.trades.map(t => ({ ...t, transactionHash: t.tx ?? t.transactionHash })),
        o.t,
      );
      if (fresh.length === 0) continue;          // whole event was duplicate
      after.tradeEvents++;
      after.tradeRows += fresh.length;
      after.lines++;
      out.push(JSON.stringify({ ...o, trades: fresh.map(({ transactionHash, ...rest }) =>
        transactionHash ? { ...rest, tx: transactionHash } : rest) }));
      continue;
    }

    if (o?.type === "book") before.books++;
    else if (o?.type === "tick") before.ticks++;
    else before.other++;
    after.lines++;
    out.push(s);
  }

  if (!dryRun) await fsp.writeFile(path.join(outDir, f), out.join("\n") + "\n");
  process.stdout.write(".");
}
console.log("");

const d = deduper.snapshot();
const pct = (a, b) => b ? (a / b * 100).toFixed(1) + "%" : "n/a";

console.log("\n── ÖNCE ──");
console.log(`  satır          ${before.lines}`);
console.log(`  book           ${before.books}`);
console.log(`  tick           ${before.ticks}`);
console.log(`  wallet_trades  ${before.tradeEvents} olay, ${before.tradeRows} işlem satırı`);
console.log(`  bozuk satır    ${before.bad}`);

console.log("\n── SONRA ──");
console.log(`  satır          ${after.lines}   (${pct(before.lines - after.lines, before.lines)} azaldı)`);
console.log(`  wallet_trades  ${after.tradeEvents} olay, ${after.tradeRows} işlem satırı`);
console.log(`  book/tick      dokunulmadı — aynı fiyat iki kez görülmesi gerçek bir gözlem`);

console.log("\n── DEDUP ──");
console.log(`  sunulan        ${d.offered}`);
console.log(`  kabul          ${d.accepted}`);
console.log(`  tekrar         ${d.duplicates}  (${pct(d.duplicates, d.offered)})`);
console.log(`  tekrar oranı   ${before.tradeRows && after.tradeRows ? (before.tradeRows / after.tradeRows).toFixed(1) : "?"}x`);
console.log(`  zayıf kimlik   ${d.inexactKeys}  (transactionHash yok, öznitelik anahtarına düşüldü)`);
if (d.inexactKeys > 0) {
  console.log(`     bu kayıtlarda aynı cüzdanın aynı saniyede aynı fiyat ve`);
  console.log(`     boyutta iki ayrı işlemi tek sayılmış olabilir — yeni`);
  console.log(`     kayıtlarda tx alanı olduğu için bu belirsizlik kalkıyor`);
}
console.log(`  bellek tavanı  ${d.overflowDrops} anahtar düştü` +
  (d.overflowDrops > 0 ? "  <- tavanı yükselt, tekrar kaçmış olabilir" : ""));

if (dryRun) console.log("\n(dry run — hiçbir şey yazılmadı)");
else console.log(`\nTemiz kopya: ${outDir}   Orijinaller değişmedi.`);
