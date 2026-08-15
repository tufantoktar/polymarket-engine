#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/countEventSupply.js — how fast does testable supply accumulate?
// ═══════════════════════════════════════════════════════════════════════
//  COUNTING ONLY. Computes no outcome statistic, so it is safe to run as
//  often as you like. That separation is the point: counting how much
//  data exists cannot p-hack a result, whereas recomputing the outcome
//  every month until it looks good absolutely can.
//
//  Reads the cache researchEventMispricing already wrote. No network.
//
//  The eligibility helpers below are copied VERBATIM from that script.
//  A copy that drifts would produce a supply rate for a population the
//  study never analysed, so the copy is examined rather than trusted:
//  it must reproduce the study's own totals or this exits non-zero.
// ═══════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";

const CACHE = "data/research/mispricing";
const HORIZONS = [30, 14, 7, 3, 1];

// Reference values printed by researchEventMispricing on this cache.
const EXPECT = { usable: 2100, events: 390, withHistory: 324 };

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
function resolvedOutcome(m) {
  try {
    const prices = typeof m.outcomePrices === "string"
      ? JSON.parse(m.outcomePrices) : m.outcomePrices;
    if (!Array.isArray(prices) || prices.length < 2) return null;
    const yes = Number(prices[0]), no = Number(prices[1]);
    if (!Number.isFinite(yes) || !Number.isFinite(no)) return null;
    const TOL = 0.01;
    if (yes >= 1 - TOL && no <= TOL) return 1;
    if (yes <= TOL && no >= 1 - TOL) return 0;
    return null;
  } catch { return null; }
}

const markets = JSON.parse(fs.readFileSync(path.join(CACHE, "markets.json"), "utf8"));
const prices = JSON.parse(fs.readFileSync(path.join(CACHE, "prices.json"), "utf8"));

const usable = [];
for (const m of markets) {
  const toks = tokensOf(m);
  if (!toks.length) continue;
  const y = resolvedOutcome(m);
  if (y === null) continue;
  const closed = m.closedTime ? Date.parse(m.closedTime) : NaN;
  const scheduled = m.endDate ? Date.parse(m.endDate) : NaN;
  const end = Number.isFinite(closed) ? closed : scheduled;
  if (!Number.isFinite(end)) continue;
  const hist = prices[toks[0]];
  usable.push({
    token: toks[0],
    cluster: clusterKey(m).key,
    resolvedAt: end,
    month: new Date(end).toISOString().slice(0, 7),
    hist: Array.isArray(hist) ? hist : [],
  });
}

const events = new Set(usable.map(u => u.cluster)).size;
const withHistory = usable.filter(u => u.hist.length > 0).length;

console.log("══════════ KOPYA SADAKAT SINAVI ══════════");
const rows = [["kullanılabilir market", usable.length, EXPECT.usable],
              ["farklı event", events, EXPECT.events],
              ["fiyat geçmişi olan market", withHistory, EXPECT.withHistory]];
let ok = true;
for (const [label, got, want] of rows) {
  const good = got === want;
  ok = ok && good;
  console.log(`  ${label.padEnd(28)} ${String(got).padStart(6)}  beklenen ${String(want).padStart(6)}  ${good ? "OK" : "UYUŞMUYOR"}`);
}
if (!ok) {
  console.log("\n  Kopyalanan filtre çalışmanınkinden farklı davranıyor.");
  console.log("  Bu sayımdan çıkacak hiçbir hız rakamı güvenilir olmaz. Duruyorum.");
  process.exit(1);
}
console.log("  -> kopya sadık, sayıma devam\n");

// ─── Supply by resolution month ─────────────────────────────────────────
//  A horizon observation needs a price point at or before
//  (resolution - H days). If a market's recorded history begins after
//  that moment the horizon simply does not exist for it, which is why
//  short-lived markets cannot serve the long horizons at any sample size.
function hasHorizon(hist, resolvedAtMs, H) {
  if (!hist.length) return false;
  const target = resolvedAtMs / 1000 - H * 86400;
  return hist.some(([t]) => t <= target);
}

const byMonth = new Map();
for (const u of usable) {
  let b = byMonth.get(u.month);
  if (!b) byMonth.set(u.month, b = {
    markets: 0, hist: 0, events: new Set(), spans: [],
    hEvents: Object.fromEntries(HORIZONS.map(h => [h, new Set()])),
  });
  b.markets++;
  b.events.add(u.cluster);
  if (u.hist.length) {
    b.hist++;
    const ts = u.hist.map(([t]) => t);
    b.spans.push((Math.max(...ts) - Math.min(...ts)) / 86400);
    for (const H of HORIZONS) {
      if (hasHorizon(u.hist, u.resolvedAt, H)) b.hEvents[H].add(u.cluster);
    }
  }
}

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

const months = [...byMonth.keys()].sort();
console.log("══════════ ÇÖZÜLME AYINA GÖRE ARZ ══════════");
console.log("  ay        market  event  geçmişli   %   medyan gün" +
            HORIZONS.map(h => ("ev" + h + "g").padStart(7)).join(""));
for (const mo of months) {
  const b = byMonth.get(mo);
  const pct = b.markets ? (100 * b.hist / b.markets).toFixed(0) : "0";
  const med = median(b.spans);
  console.log(
    `  ${mo}  ${String(b.markets).padStart(6)} ${String(b.events.size).padStart(6)} ` +
    `${String(b.hist).padStart(9)} ${pct.padStart(4)} ${(med === null ? "-" : med.toFixed(1)).padStart(11)}` +
    HORIZONS.map(h => String(b.hEvents[h].size).padStart(7)).join(""));
}

// ─── Accrual ────────────────────────────────────────────────────────────
//  The current month is partial and would drag any rate downwards, so it
//  is excluded rather than averaged in.
const complete = months.slice(0, -1);
const recent = complete.slice(-6);
console.log(`\n══════════ BİRİKİM HIZI (son ${recent.length} tam ay) ══════════`);
if (recent.length) {
  for (const H of HORIZONS) {
    const total = recent.reduce((s, mo) => s + byMonth.get(mo).hEvents[H].size, 0);
    const perMonth = total / recent.length;
    const have = months.reduce((s, mo) => s + byMonth.get(mo).hEvents[H].size, 0);
    const need5c = 500, need3c = 1400;
    const eta = n => perMonth > 0
      ? `${Math.ceil((n - have) / perMonth)} ay` : "asla (bu hızda)";
    console.log(`  ${String(H).padStart(2)}g ufku: elde ${String(have).padStart(4)} event, ` +
      `ayda ${perMonth.toFixed(1)} -> 500 için ${eta(need5c).padStart(14)}, 1400 için ${eta(need3c)}`);
  }
}
console.log("\n  500 event = 5 sentlik sapmayı ~%80 güçle yakalar");
console.log("  1400 event = 3 sentlik sapma için");
console.log("\n  Bu script hiçbir sonuç istatistiği hesaplamaz. Sadece arz sayar.");
