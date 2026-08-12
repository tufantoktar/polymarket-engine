// ═══════════════════════════════════════════════════════════════════════
//  scripts/testPriceBand.js — the band every signal source must obey
// ═══════════════════════════════════════════════════════════════════════
//  The band began as two inline conditions in momSigs and orderflowSigs.
//  smartMoneySigs was written later and simply did not have it, which was
//  invisible until a real backtest bought a token at 0.9840 that then went
//  to zero. Nothing in the test suite objected, because each signal was
//  tested in isolation against its own fixtures.
//
//  This suite therefore does not test "the band function". It enumerates
//  the signal generators and asserts each one refuses extreme prices. A
//  new generator added without the check fails the last assertion here.
// ═══════════════════════════════════════════════════════════════════════

import {
  isTradablePrice, rewardRiskRatio, resolvePriceBand, DEFAULT_PRICE_BAND,
} from "../src/engine/priceBand.js";
import { momSigs, orderflowSigs } from "../src/engine/alpha.js";
import { smartMoneySigs } from "../src/engine/smartMoney.js";
import { SignalEngine } from "../src/live/signal_engine/index.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  if (!cond) console.error(`  FAIL ${name}${detail ? ": " + detail : ""}`);
};
const silentLog = {
  info: () => {}, warn: () => {}, debug: () => {}, error: () => {},
  decision: () => {}, trade: () => {}, errorEvent: () => {},
};

// ─── 1. The band itself ─────────────────────────────────────────────────
assert("band: default is 0.20-0.80",
  DEFAULT_PRICE_BAND.min === 0.20 && DEFAULT_PRICE_BAND.max === 0.80);

for (const px of [0.20, 0.35, 0.50, 0.65, 0.80]) {
  assert(`band: accepts ${px}`, isTradablePrice(px));
}
for (const px of [0, 0.01, 0.10, 0.19, 0.81, 0.90, 0.99, 1]) {
  assert(`band: rejects ${px}`, !isTradablePrice(px));
}
for (const bad of [NaN, Infinity, -Infinity, null, undefined, "0.5"]) {
  assert(`band: rejects non-finite ${String(bad)}`, !isTradablePrice(bad));
}

// The band must actually deliver the risk limit it claims. This is the
// assertion that makes 0.20/0.80 a stated preference rather than a
// round number someone liked.
assert("band: edges cap reward-to-risk at 4:1",
  Math.abs(rewardRiskRatio(DEFAULT_PRICE_BAND.min, "BUY_YES") - 4) < 1e-9 &&
  Math.abs(rewardRiskRatio(DEFAULT_PRICE_BAND.max, "BUY_NO") - 4) < 1e-9);
assert("band: 0.90 would have been 9:1 (why the old band was wrong)",
  Math.abs(rewardRiskRatio(0.10, "BUY_YES") - 9) < 1e-9);
assert("band: reward-to-risk is symmetric at 0.5",
  rewardRiskRatio(0.5, "BUY_YES") === 1 && rewardRiskRatio(0.5, "BUY_NO") === 1);

// ─── 2. Band resolution from config ─────────────────────────────────────
assert("band: resolves {priceBand:{min,max}}",
  resolvePriceBand({ priceBand: { min: 0.3, max: 0.7 } }).min === 0.3);
assert("band: resolves flat {minPrice,maxPrice}",
  resolvePriceBand({ minPrice: 0.25, maxPrice: 0.75 }).max === 0.75);
assert("band: falls back to default on empty config",
  resolvePriceBand({}).min === DEFAULT_PRICE_BAND.min);
assert("band: falls back to default on null",
  resolvePriceBand(null).max === DEFAULT_PRICE_BAND.max);
assert("band: partial config keeps the other default",
  resolvePriceBand({ priceBand: { min: 0.4 } }).max === DEFAULT_PRICE_BAND.max);

// ─── 3. Every generator must obey it ────────────────────────────────────
//  Each entry builds inputs rich enough that the generator WOULD emit a
//  signal at a mid-band price, then re-runs at extreme prices. If a
//  generator ignores the band, the extreme case produces signals.

const REGIME = { trend: "trending", vol: "low_vol", liq: "high_liq", confidence: 0.8, hurst: 0.6 };
const NOW = 1_700_000_000_000;

function priceSeries(px, n = 60) {
  // Rising series ending at px, enough points for momentum to engage.
  const out = [];
  for (let i = 0; i < n; i++) out.push(px - (n - i) * 0.001);
  return out;
}

const GENERATORS = [
  {
    name: "momSigs",
    run: (px, cfg) => momSigs(
      { tok: { id: "tok", yes: px, vol: 0.02, cat: "c", adv: 50_000 } },
      { tok: { prices: priceSeries(px), spreads: [], depths: [], maxLen: 300 } },
      NOW, REGIME, cfg,
    ),
  },
  {
    name: "orderflowSigs",
    run: (px, cfg) => orderflowSigs(
      { tok: { id: "tok", yes: px, vol: 0.02, cat: "c", adv: 50_000 } },
      { tok: { bidDepth: 4000, askDepth: 900, volumeThisTick: 100 } },
      NOW, cfg,
    ),
  },
  {
    name: "smartMoneySigs",
    run: (px, cfg) => smartMoneySigs(
      { tok: { id: "tok", yes: px } },
      { tok: [
        { tokenId: "tok", wallet: "w1", side: "BUY", price: px, size: 1000, ts: NOW - 1000 },
        { tokenId: "tok", wallet: "w2", side: "BUY", price: px, size: 1000, ts: NOW - 1000 },
        { tokenId: "tok", wallet: "w3", side: "BUY", price: px, size: 1000, ts: NOW - 1000 },
      ] },
      NOW,
      { enabled: true, minAgreeingWallets: 3, minTradeNotional: 50, lookbackMs: 900_000,
        edgeScale: 1, minEdge: 0.006, maxEdge: 0.45, halfLifeMs: 300_000, expiryMs: 600_000, ...cfg },
    ),
  },
];

for (const g of GENERATORS) {
  // Sanity: the fixture must be capable of producing a signal, otherwise
  // "no signal at 0.95" would pass for the wrong reason.
  const mid = g.run(0.50, undefined);
  assert(`${g.name}: fixture produces a signal mid-band`, mid.length > 0,
    "test fixture is too weak to prove anything about the band");

  for (const px of [0.95, 0.90, 0.85, 0.15, 0.10, 0.05]) {
    const sigs = g.run(px, undefined);
    assert(`${g.name}: no signal at ${px}`, sigs.length === 0,
      JSON.stringify(sigs.map(s => ({ dir: s.dir, px: s.px }))));
  }

  // A custom band must be honoured, not just the default.
  const narrow = { priceBand: { min: 0.45, max: 0.55 } };
  assert(`${g.name}: honours a custom band (inside)`,
    g.run(0.50, narrow).length > 0);
  assert(`${g.name}: honours a custom band (outside)`,
    g.run(0.70, narrow).length === 0);
}

// ─── 4. End to end through SignalEngine ─────────────────────────────────
//  The generators can each be correct while the engine forgets to pass
//  the band. Drive the real path.
{
  const cfg = {
    signal: { priceBand: { min: 0.20, max: 0.80 }, regimeMinPoints: 30 },
    smartMoney: {
      enabled: true, minAgreeingWallets: 3, minTradeNotional: 50,
      lookbackMs: 900_000, edgeScale: 1, minEdge: 0.006, maxEdge: 0.45,
      halfLifeMs: 300_000, expiryMs: 600_000, maxTradesPerToken: 500,
    },
  };

  const feed = (engine, px) => {
    for (let i = 0; i < 60; i++) {
      engine.ingestOrderbook("tok", {
        midPrice: px - (60 - i) * 0.0005,
        spread: 0.01, bidDepth: 4000, askDepth: 900,
        bids: [{ price: px - 0.005, size: 4000 }],
        asks: [{ price: px + 0.005, size: 900 }],
      });
    }
    engine.ingestOrderbook("tok", {
      midPrice: px, spread: 0.01, bidDepth: 4000, askDepth: 900,
      bids: [{ price: px - 0.005, size: 4000 }],
      asks: [{ price: px + 0.005, size: 900 }],
    });
    const now = Date.now();
    engine.ingestWalletTrades([
      { tokenId: "tok", wallet: "w1", side: "BUY", price: px, size: 1000, ts: now - 1000 },
      { tokenId: "tok", wallet: "w2", side: "BUY", price: px, size: 1000, ts: now - 1000 },
      { tokenId: "tok", wallet: "w3", side: "BUY", price: px, size: 1000, ts: now - 1000 },
    ]);
  };

  const inside = new SignalEngine(cfg, silentLog);
  feed(inside, 0.50);
  const insideRecs = inside.generateRecommendations({ equity: 10_000 });

  const outside = new SignalEngine(cfg, silentLog);
  feed(outside, 0.95);
  const outsideRecs = outside.generateRecommendations({ equity: 10_000 });

  assert("engine: recommends inside the band", insideRecs.length > 0,
    "fixture too weak to prove the outside case");
  assert("engine: recommends nothing at 0.95", outsideRecs.length === 0,
    JSON.stringify(outsideRecs));
}

const passed = results.filter(r => r.pass).length;
console.log("");
console.log("═══════════════════════════════════════════════════");
console.log(`  Price band tests: ${passed}/${results.length} passed`);
console.log("═══════════════════════════════════════════════════");
if (passed !== results.length) process.exit(1);
