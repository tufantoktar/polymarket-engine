// ═══════════════════════════════════════════════════════════════════════
//  scripts/testSmartMoneyModule.js — V5.9 MVP smart-money signal tests
// ═══════════════════════════════════════════════════════════════════════
//  Coverage:
//    - smartMoneySigs: wallet agreement threshold, notional floor,
//      market-maker exclusion, lookback window, BUY_YES vs BUY_NO dir,
//      net-position-per-wallet (not raw trade count)
//    - SignalEngine.ingestWalletTrades: ring buffer cap, multi-token
//      routing, gated by cfg.smartMoney.enabled in generateRecommendations
//    - MarketScanner.refreshSmartMoney: no-op when disabled, filters to
//      activeTokens, normalizes data-api trade shape
//    - Backtester: "wallet_trades" events replay into ingestWalletTrades
//    - replay clock: recorded (old) trades must still be evaluated —
//      regression guard for the V5.9 wall-clock bug
// ═══════════════════════════════════════════════════════════════════════

import { smartMoneySigs } from "../src/engine/smartMoney.js";
import { SignalEngine } from "../src/live/signal_engine/index.js";
import { MarketScanner } from "../src/live/market_scanner/index.js";
import { Backtester } from "../src/backtest/runner.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  if (!cond) console.error(`  FAIL ${name}${detail ? ": " + detail : ""}`);
};

const silentLog = {
  info: () => {}, warn: () => {}, debug: () => {}, error: () => {},
  decision: () => {}, trade: () => {}, errorEvent: () => {},
};

const SM_CFG = {
  lookbackMs: 900_000,
  minTradeNotional: 50,
  minAgreeingWallets: 3,
  edgeScale: 0.06,
  minEdge: 0.006,
  maxEdge: 0.05,
  halfLifeMs: 300_000,
  expiryMs: 600_000,
};

function mkTrade(tokenId, wallet, side, price, size, ts, extra = {}) {
  return { tokenId, wallet, side, price, size, ts, ...extra };
}

// ── 1. smartMoneySigs: core agreement logic ─────────────────────────────
(() => {
  const now = 10_000_000;
  const mkts = { tokA: { id: "tokA", yes: 0.5 } };

  // Below wallet threshold (2 buyers, need 3)
  let trades = {
    tokA: [
      mkTrade("tokA", "w1", "BUY", 0.5, 200, now - 1000),
      mkTrade("tokA", "w2", "BUY", 0.5, 200, now - 1000),
    ],
  };
  let sigs = smartMoneySigs(mkts, trades, now, SM_CFG);
  assert("below wallet threshold -> no signal", sigs.length === 0, JSON.stringify(sigs));

  // 3 distinct buyers, large notional -> BUY_YES
  trades = {
    tokA: [
      mkTrade("tokA", "w1", "BUY", 0.5, 200, now - 1000),
      mkTrade("tokA", "w2", "BUY", 0.5, 300, now - 2000),
      mkTrade("tokA", "w3", "BUY", 0.5, 400, now - 3000),
    ],
  };
  sigs = smartMoneySigs(mkts, trades, now, SM_CFG);
  assert("3 agreeing buyers -> 1 signal", sigs.length === 1, JSON.stringify(sigs));
  assert("dir is BUY_YES", sigs[0]?.dir === "BUY_YES");
  assert("meta.buyWallets=3", sigs[0]?.meta.buyWallets === 3);
  assert("edge within [minEdge,maxEdge]", sigs[0].edge >= SM_CFG.minEdge && sigs[0].edge <= SM_CFG.maxEdge);

  // 3 distinct sellers -> BUY_NO
  trades = {
    tokA: [
      mkTrade("tokA", "w1", "SELL", 0.5, 200, now - 1000),
      mkTrade("tokA", "w2", "SELL", 0.5, 300, now - 2000),
      mkTrade("tokA", "w3", "SELL", 0.5, 400, now - 3000),
    ],
  };
  sigs = smartMoneySigs(mkts, trades, now, SM_CFG);
  assert("3 agreeing sellers -> BUY_NO", sigs[0]?.dir === "BUY_NO");

  // Dust trades filtered by minTradeNotional
  trades = {
    tokA: [
      mkTrade("tokA", "w1", "BUY", 0.5, 5, now - 1000),   // 2.5 notional < 50
      mkTrade("tokA", "w2", "BUY", 0.5, 5, now - 1000),
      mkTrade("tokA", "w3", "BUY", 0.5, 5, now - 1000),
    ],
  };
  sigs = smartMoneySigs(mkts, trades, now, SM_CFG);
  assert("dust trades filtered -> no signal", sigs.length === 0);

  // Market-maker trades excluded from agreement count
  trades = {
    tokA: [
      mkTrade("tokA", "w1", "BUY", 0.5, 200, now - 1000),
      mkTrade("tokA", "w2", "BUY", 0.5, 200, now - 1000),
      mkTrade("tokA", "mm1", "BUY", 0.5, 200, now - 1000, { isMarketMaker: true }),
    ],
  };
  sigs = smartMoneySigs(mkts, trades, now, SM_CFG);
  assert("MM trade excluded -> below threshold", sigs.length === 0);

  // Lookback window: stale trade dropped
  trades = {
    tokA: [
      mkTrade("tokA", "w1", "BUY", 0.5, 200, now - 2_000_000), // outside 900s lookback
      mkTrade("tokA", "w2", "BUY", 0.5, 200, now - 1000),
      mkTrade("tokA", "w3", "BUY", 0.5, 200, now - 1000),
    ],
  };
  sigs = smartMoneySigs(mkts, trades, now, SM_CFG);
  assert("stale trade outside lookback dropped -> below threshold", sigs.length === 0);

  // Wallet net position, not trade count: one wallet buys then sells more -> net seller
  trades = {
    tokA: [
      mkTrade("tokA", "w1", "BUY", 0.5, 100, now - 5000),
      mkTrade("tokA", "w1", "SELL", 0.5, 300, now - 4000),  // net seller (300 > 100)
      mkTrade("tokA", "w2", "SELL", 0.5, 200, now - 3000),
      mkTrade("tokA", "w3", "SELL", 0.5, 200, now - 2000),
    ],
  };
  sigs = smartMoneySigs(mkts, trades, now, SM_CFG);
  assert("net-position wallet counted once as seller", sigs[0]?.meta.sellWallets === 3, JSON.stringify(sigs[0]?.meta));
  assert("net-position -> BUY_NO", sigs[0]?.dir === "BUY_NO");

  // No trades for a token -> skipped cleanly
  sigs = smartMoneySigs({ tokB: { id: "tokB", yes: 0.5 } }, {}, now, SM_CFG);
  assert("no trades -> no signals, no throw", sigs.length === 0);
})();

// ── 2. SignalEngine.ingestWalletTrades ───────────────────────────────────
(() => {
  const cfgDisabled = { smartMoney: { ...SM_CFG, enabled: false, maxTradesPerToken: 5 } };
  const engDisabled = new SignalEngine(cfgDisabled, silentLog);
  engDisabled.ingestOrderbook("tokA", { midPrice: 0.5, spread: 0.02, bidDepth: 500, askDepth: 500 });
  const now = Date.now();
  engDisabled.ingestWalletTrades([
    mkTrade("tokA", "w1", "BUY", 0.5, 200, now - 1000),
    mkTrade("tokA", "w2", "BUY", 0.5, 200, now - 1000),
    mkTrade("tokA", "w3", "BUY", 0.5, 200, now - 1000),
  ]);
  const recsDisabled = engDisabled.generateRecommendations({ equity: 1000 });
  assert(
    "smartMoney disabled -> no smartMoney-sourced recs",
    !recsDisabled.some(r => r.attr && r.attr.smartMoney !== undefined),
  );

  // Note: end-to-end sizing (processSigs' Kelly formula) is conservative
  // by design for a single-source signal at CFG defaults — a realistic
  // MVP edge/conf alone won't clear the 15-contract minimum order size.
  // That's expected (matches how momentum/orderflow behave solo too);
  // here we just confirm the *wiring* — enabled trades flow through to a
  // sized rec — using a deliberately strong synthetic edge.
  const cfgEnabled = {
    smartMoney: { ...SM_CFG, enabled: true, maxTradesPerToken: 5, edgeScale: 1, maxEdge: 0.45 },
  };
  const engEnabled = new SignalEngine(cfgEnabled, silentLog);
  engEnabled.ingestOrderbook("tokA", { midPrice: 0.5, spread: 0.02, bidDepth: 500, askDepth: 500 });
  engEnabled.ingestWalletTrades([
    mkTrade("tokA", "w1", "BUY", 0.5, 1000, now - 1000),
    mkTrade("tokA", "w2", "BUY", 0.5, 1000, now - 1000),
    mkTrade("tokA", "w3", "BUY", 0.5, 1000, now - 1000),
  ]);
  const recsEnabled = engEnabled.generateRecommendations({ equity: 1000 });
  assert(
    "smartMoney enabled + strong agreement -> at least one rec attributed to smartMoney",
    recsEnabled.some(r => r.attr && r.attr.smartMoney !== undefined),
    JSON.stringify(recsEnabled),
  );

  // Ring buffer cap
  const engCap = new SignalEngine({ smartMoney: { ...SM_CFG, enabled: true, maxTradesPerToken: 5 } }, silentLog);
  const many = Array.from({ length: 20 }, (_, i) => mkTrade("tokA", "w" + i, "BUY", 0.5, 60, now - i * 100));
  engCap.ingestWalletTrades(many);
  assert("ring buffer capped at maxTradesPerToken", engCap.walletTrades.get("tokA").length === 5);
  assert(
    "ring buffer keeps most recent (tail) entries",
    engCap.walletTrades.get("tokA")[4].wallet === "w19",
  );

  // Multi-token routing
  const engMulti = new SignalEngine({ smartMoney: { ...SM_CFG, enabled: true } }, silentLog);
  engMulti.ingestWalletTrades([
    mkTrade("tokA", "w1", "BUY", 0.5, 60, now),
    mkTrade("tokB", "w2", "SELL", 0.5, 60, now),
  ]);
  assert("trades routed to correct per-token buckets", engMulti.walletTrades.get("tokA").length === 1);
  assert("trades routed to correct per-token buckets (tokB)", engMulti.walletTrades.get("tokB").length === 1);

  // Malformed input doesn't throw
  let threw = false;
  try {
    engMulti.ingestWalletTrades(null);
    engMulti.ingestWalletTrades([{ wallet: "no-token-id" }]);
  } catch { threw = true; }
  assert("ingestWalletTrades tolerates malformed input", !threw);
})();

// ── 3. MarketScanner.refreshSmartMoney ───────────────────────────────────
async function testMarketScanner() {
  const fakeClientDisabled = {
    getWalletTrades: async () => { throw new Error("should not be called when disabled"); },
  };
  const scannerDisabled = new MarketScanner({
    cfg: { smartMoney: { enabled: false }, marketScanner: {} },
    logger: silentLog,
    client: fakeClientDisabled,
    signalEngine: { ingestWalletTrades: () => { throw new Error("should not be called"); } },
  });
  let threw = false;
  try { await scannerDisabled.refreshSmartMoney(); } catch { threw = true; }
  assert("refreshSmartMoney no-ops when disabled", !threw);

  let capturedTrades = null;
  const fakeClientEnabled = {
    getWalletTrades: async () => ([
      { proxyWallet: "0xabc", side: "BUY", asset: "tokA", size: 10, price: 0.5, timestamp: Math.floor(Date.now() / 1000) },
      { proxyWallet: "0xdef", side: "SELL", asset: "tokUntracked", size: 10, price: 0.5, timestamp: Math.floor(Date.now() / 1000) },
    ]),
  };
  const scannerEnabled = new MarketScanner({
    cfg: { smartMoney: { enabled: true, pollLimit: 200 }, marketScanner: {} },
    logger: silentLog,
    client: fakeClientEnabled,
    signalEngine: { ingestWalletTrades: (trades) => { capturedTrades = trades; } },
  });
  scannerEnabled.activeTokens.set("tokA", { marketId: "m1" });
  await scannerEnabled.refreshSmartMoney();
  assert("refreshSmartMoney filters to activeTokens only", capturedTrades && capturedTrades.length === 1, JSON.stringify(capturedTrades));
  assert("refreshSmartMoney normalizes asset->tokenId", capturedTrades?.[0]?.tokenId === "tokA");
  assert("refreshSmartMoney normalizes proxyWallet->wallet", capturedTrades?.[0]?.wallet === "0xabc");

  // Errors in the fetch are swallowed (matches refreshActiveTokens pattern)
  const fakeClientErroring = { getWalletTrades: async () => { throw new Error("network down"); } };
  const scannerErroring = new MarketScanner({
    cfg: { smartMoney: { enabled: true }, marketScanner: {} },
    logger: silentLog,
    client: fakeClientErroring,
    signalEngine: { ingestWalletTrades: () => {} },
  });
  let threw2 = false;
  try { await scannerErroring.refreshSmartMoney(); } catch { threw2 = true; }
  assert("refreshSmartMoney swallows client errors", !threw2);
}

// ── 4. Backtester replays wallet_trades events ───────────────────────────
async function testBacktesterReplay() {
  const cfg = {
    filters: {}, marketScanner: {}, signal: {}, portfolio: {},
    smartMoney: { ...SM_CFG, enabled: true },
  };
  const bt = new Backtester({ cfg, opts: { warmupTicks: 0 } });
  const now = Date.now();

  async function* fakeEvents() {
    yield { type: "meta", tokens: [{ tokenId: "tokA", question: "q", category: "c", adv: 10000 }] };
    yield { type: "book", tokenId: "tokA", book: { midPrice: 0.5, spread: 0.02, bidDepth: 500, askDepth: 500 } };
    yield {
      type: "wallet_trades",
      trades: [
        mkTrade("tokA", "w1", "BUY", 0.5, 300, now - 1000),
        mkTrade("tokA", "w2", "BUY", 0.5, 300, now - 1000),
        mkTrade("tokA", "w3", "BUY", 0.5, 300, now - 1000),
      ],
    };
    yield { type: "tick", t: now };
  }

  const report = await bt.run(fakeEvents());
  assert(
    "backtester ingests wallet_trades without throwing",
    report && report.counters.events === 4,
    JSON.stringify(report?.counters),
  );
  assert(
    "SignalEngine inside Backtester received the wallet trades",
    bt.signalEngine.walletTrades.get("tokA")?.length === 3,
  );
}

// ── 5. REPLAY CLOCK — the regression that shipped in V5.9 ────────────
//  V5.9 shipped with smartMoneySigs filtering trades against Date.now()
//  because SignalEngine.generateRecommendations() hard-coded its own
//  clock. Every test in this file used fresh Date.now() timestamps, so
//  all 26 passed — while the signal was incapable of firing during an
//  actual backtest, where recorded trades are hours or days old. The
//  first real backtest produced byte-identical results with the signal
//  on and off, which is how it was caught.
//
//  These assertions replay trades with RECORDED (old) timestamps, the
//  way a real recording does. They fail against the pre-fix code.
async function testReplayClock() {
  const cfg = {
    filters: {}, marketScanner: {}, signal: {}, portfolio: {},
    smartMoney: { ...SM_CFG, enabled: true, edgeScale: 1, maxEdge: 0.45 },
  };

  // A recording made 24h ago — the normal case, not an edge case.
  const recordedNow = Date.now() - 24 * 60 * 60 * 1000;

  function events(tickTime, tradeTime) {
    return (async function* () {
      yield { type: "meta", tokens: [{ tokenId: "tokA", question: "q", category: "c", adv: 10000 }] };
      yield { type: "book", tokenId: "tokA", book: { midPrice: 0.5, spread: 0.02, bidDepth: 900, askDepth: 900 } };
      yield {
        type: "wallet_trades",
        trades: [
          mkTrade("tokA", "w1", "BUY", 0.5, 1000, tradeTime),
          mkTrade("tokA", "w2", "BUY", 0.5, 1000, tradeTime),
          mkTrade("tokA", "w3", "BUY", 0.5, 1000, tradeTime),
        ],
      };
      yield { type: "tick", t: tickTime };
    })();
  }

  // Trades recorded 1 minute before the tick that evaluates them —
  // comfortably inside the 15-minute lookback *in recording time*.
  const bt = new Backtester({ cfg, opts: { warmupTicks: 0 } });
  const report = await bt.run(events(recordedNow, recordedNow - 60_000));
  assert(
    "replay: recorded wallet trades still produce recommendations",
    report.counters.recs > 0,
    `recs=${report.counters.recs} — signal evaluated against wall clock instead of replay clock?`,
  );

  // Same recording, but the trades are genuinely stale relative to the
  // tick (2h before it). The lookback must still exclude them, otherwise
  // we have merely swapped one bug for another.
  const btStale = new Backtester({ cfg, opts: { warmupTicks: 0 } });
  const staleReport = await btStale.run(events(recordedNow, recordedNow - 2 * 60 * 60 * 1000));
  assert(
    "replay: trades outside the lookback are still excluded",
    staleReport.counters.recs === 0,
    `recs=${staleReport.counters.recs}`,
  );

  // The clock must be the tick's timestamp, not the ingest order.
  const btFuture = new Backtester({ cfg, opts: { warmupTicks: 0 } });
  const futureReport = await btFuture.run(events(recordedNow, recordedNow + 60_000));
  assert(
    "replay: trades timestamped after the tick are excluded",
    futureReport.counters.recs === 0,
    `recs=${futureReport.counters.recs}`,
  );

  // Live callers omit the clock and must keep wall-clock behaviour.
  const engLive = new SignalEngine(cfg, silentLog);
  engLive.ingestOrderbook("tokA", { midPrice: 0.5, spread: 0.02, bidDepth: 900, askDepth: 900 });
  const freshNow = Date.now();
  engLive.ingestWalletTrades([
    mkTrade("tokA", "w1", "BUY", 0.5, 1000, freshNow - 1000),
    mkTrade("tokA", "w2", "BUY", 0.5, 1000, freshNow - 1000),
    mkTrade("tokA", "w3", "BUY", 0.5, 1000, freshNow - 1000),
  ]);
  const liveRecs = engLive.generateRecommendations({ equity: 1000 });
  assert(
    "live: omitting the clock still defaults to wall clock",
    liveRecs.some(r => r.attr && r.attr.smartMoney !== undefined),
    JSON.stringify(liveRecs),
  );
}

await testMarketScanner();
await testBacktesterReplay();
await testReplayClock();

const passed = results.filter(r => r.pass).length;
console.log("");
console.log("═══════════════════════════════════════════════════");
console.log(`  Smart money module tests: ${passed}/${results.length} passed`);
console.log("═══════════════════════════════════════════════════");
if (passed !== results.length) process.exit(1);
