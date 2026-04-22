// ═══════════════════════════════════════════════════════════════════════
//  scripts/testReliabilityModules.js — unit tests for V5.5 new modules
// ═══════════════════════════════════════════════════════════════════════
//  Coverage:
//    - slippage: estimateExecutionPrice, computeSlippage, checkLiquidity,
//                evaluateSlippageAndLiquidity
//    - killSwitch: thresholds, stuck-order detection, manual trigger
//    - reconciliation: order + position drift resolution
//    - startupRecovery: restore open orders + deduper population
//    - health: status composition + summary line
// ═══════════════════════════════════════════════════════════════════════

import {
  estimateExecutionPrice,
  computeSlippage,
  checkLiquidity,
  evaluateSlippageAndLiquidity,
} from "../src/live/execution/slippage.js";
import { KillSwitch } from "../src/live/monitoring/killSwitch.js";
import { HealthMonitor } from "../src/live/monitoring/health.js";
import { OrderStore } from "../src/live/state/orderStore.js";
import { PositionStore } from "../src/live/state/positionStore.js";
import { SignalDeduper } from "../src/live/state/signalDeduper.js";
import { ORDER_STATES } from "../src/live/state/orderStateMachine.js";
import { syncPositions } from "../src/live/sync/reconciliation.js";
import { runStartupRecovery } from "../src/live/sync/startupRecovery.js";
import { LIVE_CONFIG } from "../src/live/config.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  if (!cond) console.error(`  FAIL ${name}${detail ? ": " + detail : ""}`);
};

// Silent logger for tests
const silentLog = {
  info: () => {}, warn: () => {}, debug: () => {}, error: () => {},
  decision: () => {}, trade: () => {}, errorEvent: () => {},
};

// Deep book for slippage tests (same shape as PolymarketClient returns)
const deepBook = {
  bids: [
    { price: 0.48, size: 100 },
    { price: 0.47, size: 200 },
    { price: 0.46, size: 500 },
  ],
  asks: [
    { price: 0.52, size: 100 },
    { price: 0.53, size: 200 },
    { price: 0.54, size: 500 },
  ],
  bestBid: 0.48, bestAsk: 0.52,
  midPrice: 0.50, spread: 0.04,
  bidDepth: 100*0.48 + 200*0.47 + 500*0.46,
  askDepth: 100*0.52 + 200*0.53 + 500*0.54,
};

// ───────────────────────────────────────────────────────────────────────
// SECTION 1: slippage module
// ───────────────────────────────────────────────────────────────────────
{
  // estimateExecutionPrice — BUY walks asks cheap→expensive
  const r1 = estimateExecutionPrice(deepBook, "BUY", 100);
  assert("slip:BUY 100 fills at best ask only", Math.abs(r1.estimatedPrice - 0.52) < 1e-9);
  assert("slip:BUY 100 no shortfall", r1.shortfall === 0);
  assert("slip:BUY 100 touches 1 level", r1.levelsTouched === 1);

  const r2 = estimateExecutionPrice(deepBook, "BUY", 250);
  // VWAP: (100*0.52 + 150*0.53) / 250 = 0.526
  assert("slip:BUY 250 walks two levels", Math.abs(r2.estimatedPrice - 0.526) < 1e-6, `got ${r2.estimatedPrice}`);
  assert("slip:BUY 250 no shortfall", r2.shortfall === 0);

  // Book too thin
  const r3 = estimateExecutionPrice(deepBook, "BUY", 10000);
  assert("slip:thin book reports shortfall", r3.shortfall > 0);

  // SELL walks bids expensive→cheap
  const r4 = estimateExecutionPrice(deepBook, "SELL", 100);
  assert("slip:SELL 100 @ best bid", Math.abs(r4.estimatedPrice - 0.48) < 1e-9);

  // computeSlippage
  const s1 = computeSlippage(0.526, 0.50, "BUY");
  assert("slip:BUY slippage positive bps", s1.slippageBps > 0);
  assert("slip:BUY slippage ≈ 520bps", Math.abs(s1.slippageBps - 520) < 1);

  const s2 = computeSlippage(0.48, 0.50, "SELL");
  assert("slip:SELL slippage positive (price improvement is negative)", s2.slippageBps > 0);

  // checkLiquidity
  const bidLiq = checkLiquidity(deepBook, "SELL");
  const askLiq = checkLiquidity(deepBook, "BUY");
  assert("slip:bid liquidity matches depth", Math.abs(bidLiq - deepBook.bidDepth) < 1e-6);
  assert("slip:ask liquidity matches depth", Math.abs(askLiq - deepBook.askDepth) < 1e-6);

  // evaluateSlippageAndLiquidity — allowed small order
  const ev1 = evaluateSlippageAndLiquidity({
    book: deepBook, side: "BUY", size: 50, referencePrice: 0.50,
    maxSlippageBps: 500, minLiquidity: 50,
  });
  assert("slip:guard allows small order", ev1.allowed === true);
  assert("slip:guard reports level touched", ev1.levelsTouched === 1);

  // Rejected: slippage exceeds threshold
  const ev2 = evaluateSlippageAndLiquidity({
    book: deepBook, side: "BUY", size: 250, referencePrice: 0.50,
    maxSlippageBps: 100, minLiquidity: 0,
  });
  assert("slip:guard rejects high slippage", ev2.allowed === false);
  assert("slip:guard reason contains slippage", /slippage/.test(ev2.reason));

  // Rejected: thin book
  const ev3 = evaluateSlippageAndLiquidity({
    book: deepBook, side: "BUY", size: 10000, referencePrice: 0.50,
    maxSlippageBps: 9999, minLiquidity: 0,
  });
  assert("slip:guard rejects on shortfall", ev3.allowed === false);
  assert("slip:guard reports book_too_thin", /book_too_thin/.test(ev3.reason));

  // Rejected: insufficient liquidity
  const ev4 = evaluateSlippageAndLiquidity({
    book: deepBook, side: "BUY", size: 10, referencePrice: 0.50,
    maxSlippageBps: 9999, minLiquidity: 999999,
  });
  assert("slip:guard rejects insufficient liquidity", ev4.allowed === false);
  assert("slip:guard reason insufficient_liquidity", /insufficient_liquidity/.test(ev4.reason));

  // No orderbook
  const ev5 = evaluateSlippageAndLiquidity({ book: null, side: "BUY", size: 10 });
  assert("slip:guard handles missing book", !ev5.allowed && ev5.reason === "no_orderbook");

  // Invalid inputs throw
  let threw = false;
  try { estimateExecutionPrice(deepBook, "BAD", 10); } catch { threw = true; }
  assert("slip:rejects bad side", threw);
}

// ───────────────────────────────────────────────────────────────────────
// SECTION 2: killSwitch module
// ───────────────────────────────────────────────────────────────────────
{
  const cfg = { ...LIVE_CONFIG, risk: { ...LIVE_CONFIG.risk, maxDailyLoss: 50 }, killSwitchFile: ".KILL_DOES_NOT_EXIST_TEST" };
  const ks = new KillSwitch({
    config: cfg, logger: silentLog,
    monitoring: { maxConsecutiveErrors: 3, maxApiFailureRate: 0.5, apiWindowSize: 10, stuckOrderTimeoutMs: 50 },
  });

  // Initially not halted
  assert("ks:fresh not halted", !ks.isHalted());
  assert("ks:evaluate returns null when clean", ks.evaluate({ dailyRealizedPnl: 0, openOrders: [] }) === null);

  // Daily loss trigger
  const r = ks.evaluate({ dailyRealizedPnl: -100, openOrders: [] });
  assert("ks:daily_loss triggers halt", r && r.trigger === "daily_loss");
  assert("ks:halted after daily_loss", ks.isHalted());
  // Subsequent evaluate doesn't re-log / re-trigger
  const r2 = ks.evaluate({ dailyRealizedPnl: 0, openOrders: [] });
  assert("ks:halt is sticky", ks.isHalted() && r2.trigger === "daily_loss");

  // Consecutive errors
  const ks2 = new KillSwitch({ config: cfg, logger: silentLog, monitoring: { maxConsecutiveErrors: 3, apiWindowSize: 10 } });
  ks2.recordApiFailure(); ks2.recordApiFailure(); ks2.recordApiFailure();
  const rc = ks2.evaluate({ dailyRealizedPnl: 0, openOrders: [] });
  assert("ks:consecutive_errors triggers", rc && rc.trigger === "consecutive_errors");

  // recordApiSuccess resets consecutive counter
  const ks3 = new KillSwitch({ config: cfg, logger: silentLog, monitoring: { maxConsecutiveErrors: 3, apiWindowSize: 10 } });
  ks3.recordApiFailure(); ks3.recordApiFailure();
  ks3.recordApiSuccess();
  ks3.recordApiFailure();
  const rc2 = ks3.evaluate({ dailyRealizedPnl: 0, openOrders: [] });
  assert("ks:success resets consecutive", !rc2);

  // API failure rate
  const ks4 = new KillSwitch({ config: cfg, logger: silentLog,
    monitoring: { maxConsecutiveErrors: 999, maxApiFailureRate: 0.5, apiWindowSize: 10 } });
  for (let i = 0; i < 10; i++) ks4.recordApiFailure();
  const rr = ks4.evaluate({ dailyRealizedPnl: 0, openOrders: [] });
  assert("ks:api_failure_rate triggers", rr && rr.trigger === "api_failure_rate");

  // Stuck orders
  const ks5 = new KillSwitch({ config: cfg, logger: silentLog,
    monitoring: { maxConsecutiveErrors: 999, maxApiFailureRate: 1, apiWindowSize: 10, stuckOrderTimeoutMs: 10 } });
  const fakeOrder = {
    orderId: "o1", state: ORDER_STATES.ORDER_PLACED,
    placedAt: Date.now() - 100, createdAt: Date.now() - 100,
  };
  ks5.recordOrderProgress("o1");
  // Wait
  const t0 = Date.now(); while (Date.now() - t0 < 25) {}
  const rs = ks5.evaluate({ dailyRealizedPnl: 0, openOrders: [fakeOrder] });
  assert("ks:stuck_orders triggers", rs && rs.trigger === "stuck_orders");
  assert("ks:stuck includes orderId", rs.detail.orders.some(o => o.orderId === "o1"));

  // Manual trigger
  const ks6 = new KillSwitch({ config: cfg, logger: silentLog });
  const r6 = ks6.triggerManual("shutdown");
  assert("ks:manual trigger halts", ks6.isHalted() && r6.trigger === "manual_api");

  // Snapshot shape
  const snap = ks6.snapshot();
  assert("ks:snapshot has halted", snap.halted === true);
  assert("ks:snapshot has reason", snap.reason !== null);
  assert("ks:snapshot has thresholds", typeof snap.thresholds === "object");
}

// ───────────────────────────────────────────────────────────────────────
// SECTION 3: health monitor
// ───────────────────────────────────────────────────────────────────────
{
  const orderStore = new OrderStore();
  const positionStore = new PositionStore();
  const risk = { snapshot: () => ({ day: "2026-04-21", realizedPnlToday: -5, rejectsToday: 2, openOrderCount: 0 }) };
  const ks = new KillSwitch({ config: LIVE_CONFIG, logger: silentLog });

  const hm = new HealthMonitor({ orderStore, positionStore, risk, killSwitch: ks, config: LIVE_CONFIG });
  hm.markRunning();
  hm.recordTick(); hm.recordTick();
  const s = hm.getHealthStatus();
  assert("health:running flag set", s.running === true);
  assert("health:tickCount=2", s.tickCount === 2);
  assert("health:dailyPnl from risk", s.dailyPnl === -5);
  assert("health:openOrders=0", s.openOrders === 0);
  assert("health:halted=false", s.halted === false);

  // Trigger kill switch, health reflects it
  ks.triggerManual("test");
  const s2 = hm.getHealthStatus();
  assert("health:halted after kill", s2.halted === true);
  assert("health:killSwitchReason populated", s2.killSwitchReason !== null);

  // Summary line contains HALTED tag
  assert("health:summary line with HALT", /HALTED|HALT=/.test(hm.getSummaryLine()));

  // Recovery tracking
  hm.recordRecoveryStarted();
  assert("health:recovery.running", hm.getHealthStatus().recovery.status === "running");
  hm.recordRecoveryFinished({ ok: true, ordersRestored: 2 });
  assert("health:recovery.ok", hm.getHealthStatus().recovery.status === "ok");

  // Reconciliation tracking
  hm.recordReconciliation({
    timestamp: Date.now(), positionsRestored: 1, positionsCorrected: 0,
    ordersRestored: 0, ordersCorrected: 3, mismatches: [{}, {}, {}], errors: [],
  });
  const s3 = hm.getHealthStatus();
  assert("health:lastReconcileAt populated", typeof s3.lastReconcileAt === "number");
  assert("health:lastReconcileSummary.ordersCorrected=3", s3.lastReconcileSummary.ordersCorrected === 3);

  // Unrealized PnL computation
  positionStore.applyFill({ tokenId: "t1", side: "BUY", size: 100, price: 0.40 });
  const s4 = hm.getHealthStatus({ livePrices: { t1: 0.60 } });
  // Unrealized = (0.60 - 0.40) * 100 = 20
  assert("health:unrealizedPnl computed", Math.abs(s4.unrealizedPnl - 20) < 1e-6);
}

// ───────────────────────────────────────────────────────────────────────
// SECTION 4: reconciliation
// ───────────────────────────────────────────────────────────────────────
{
  // Mock client with controllable remote state
  class MockClient {
    constructor() {
      this.remoteOpenOrders = [];
      this.orderStatusMap = {}; // extId → {status, ...}
    }
    async getOpenOrders() { return this.remoteOpenOrders; }
    async getOrderStatus(id) { return this.orderStatusMap[id] || null; }
  }
  class MockWallet {
    constructor() { this.balances = {}; }
    async getPositionBalance(tid) { return this.balances[tid] ?? 0; }
  }

  const cfg = { ...LIVE_CONFIG, mode: "live" };
  const client = new MockClient();
  const wallet = new MockWallet();
  const orderStore = new OrderStore();
  const positionStore = new PositionStore();
  const ks = new KillSwitch({ config: cfg, logger: silentLog });
  const risk = { syncOpenOrders: () => {}, untrackOrder: () => {} };

  // Setup: create a local order that the exchange claims is FILLED
  const { order: o } = orderStore.create({
    signalKey: "r:1", tokenId: "tok-A", side: "BUY", size: 100, price: 0.5,
  });
  orderStore.transition(o.orderId, ORDER_STATES.SIGNAL_DETECTED);
  orderStore.transition(o.orderId, ORDER_STATES.ORDER_PLACED, { externalOrderId: "EXT_A" });

  // Remote: no longer in open orders. Status endpoint says filled.
  client.remoteOpenOrders = [];
  client.orderStatusMap["EXT_A"] = { status: "filled", size_matched: 100, avg_price: 0.51 };

  const sum1 = await syncPositions({
    client, wallet, orderStore, positionStore, risk, killSwitch: ks,
    logger: silentLog, config: cfg, tokenIds: [],
  });

  assert("recon:filled order corrected", orderStore.get(o.orderId).state === ORDER_STATES.FILLED);
  assert("recon:ordersCorrected=1", sum1.ordersCorrected === 1);
  assert("recon:mismatch recorded", sum1.mismatches.some(m => m.type === "order_not_on_remote"));

  // Case 2: position drift (local=0, remote=50)
  wallet.balances["tok-B"] = 50;
  const sum2 = await syncPositions({
    client, wallet, orderStore, positionStore, risk, killSwitch: ks,
    logger: silentLog, config: cfg, tokenIds: ["tok-B"],
  });
  assert("recon:position restored", positionStore.get("tok-B").qty === 50);
  assert("recon:positionsRestored=1", sum2.positionsRestored === 1);

  // Case 3: local position, no remote
  positionStore.set("tok-C", { tokenId: "tok-C", qty: 25, avgEntryPrice: 0.4, realizedPnl: 0 });
  wallet.balances["tok-C"] = 0;
  const sum3 = await syncPositions({
    client, wallet, orderStore, positionStore, risk, killSwitch: ks,
    logger: silentLog, config: cfg, tokenIds: [],
  });
  assert("recon:position zeroed", positionStore.get("tok-C").qty === 0);
  assert("recon:positionsCorrected>=1", sum3.positionsCorrected >= 1);

  // Paper mode short-circuit
  const cfgPaper = { ...LIVE_CONFIG, mode: "paper" };
  const sum4 = await syncPositions({
    client, wallet, orderStore, positionStore, risk, killSwitch: ks,
    logger: silentLog, config: cfgPaper, tokenIds: ["tok-A"],
  });
  assert("recon:paper mode short-circuits", sum4.mode === "paper");
}

// ───────────────────────────────────────────────────────────────────────
// SECTION 5: startupRecovery
// ───────────────────────────────────────────────────────────────────────
{
  class MockClient {
    constructor(openOrders) { this.openOrders = openOrders; }
    async getOpenOrders() { return this.openOrders; }
  }
  class MockWallet {
    async getPositionBalance(tid) {
      const balances = { "tok-X": 40 };
      return balances[tid] ?? 0;
    }
  }

  const cfg = { ...LIVE_CONFIG, mode: "live", recovery: { enabled: true } };
  const client = new MockClient([
    {
      id: "EXT_Z", asset_id: "tok-Y", market: "mkt-Y", side: "BUY",
      original_size: 10, size_matched: 0, price: 0.45, created_at: 1700000000,
    },
  ]);
  const wallet = new MockWallet();
  const orderStore = new OrderStore();
  const positionStore = new PositionStore();
  const signalDeduper = new SignalDeduper({ ttlMs: 60000 });
  const ks = new KillSwitch({ config: cfg, logger: silentLog });
  const risk = { trackOrder: () => {}, syncOpenOrders: () => {} };

  const sum = await runStartupRecovery({
    client, wallet, orderStore, positionStore, signalDeduper,
    risk, killSwitch: ks, logger: silentLog, config: cfg,
    tokenIds: ["tok-X"],
  });

  assert("recovery:ok", sum.ok === true);
  assert("recovery:ordersRestored=1", sum.ordersRestored === 1);
  assert("recovery:positionsRestored=1", sum.positionsRestored === 1);
  assert("recovery:position qty correct", positionStore.get("tok-X").qty === 40);
  // Order should be in ORDER_PLACED state
  const restored = orderStore.findByExternalOrderId("EXT_Z");
  assert("recovery:order restored", restored !== null);
  assert("recovery:order in ORDER_PLACED", restored.state === ORDER_STATES.ORDER_PLACED);
  assert("recovery:signalKey marked", sum.signalsBlocked === 1);
  // Deduper should have the key so fresh signal won't duplicate
  assert("recovery:deduper populated", signalDeduper.snapshot().size === 1);

  // Paper mode short-circuits
  const cfgPaper = { ...LIVE_CONFIG, mode: "paper", recovery: { enabled: true } };
  const sumP = await runStartupRecovery({
    client, wallet, orderStore: new OrderStore(), positionStore: new PositionStore(),
    signalDeduper: new SignalDeduper(), risk, killSwitch: ks, logger: silentLog,
    config: cfgPaper,
  });
  assert("recovery:paper skips", sumP.ok && sumP.ordersRestored === 0);

  // Disabled by config
  const cfgOff = { ...LIVE_CONFIG, mode: "live", recovery: { enabled: false }, monitoring: { startupRecoveryEnabled: false } };
  const sumOff = await runStartupRecovery({
    client: new MockClient([]), wallet, orderStore: new OrderStore(), positionStore: new PositionStore(),
    signalDeduper: new SignalDeduper(), risk, killSwitch: ks, logger: silentLog,
    config: cfgOff,
  });
  assert("recovery:disabled flag honored", sumOff.skipped === true);
}

// ─── Summary ────────────────────────────────────────────────────────────
const pass = results.filter(r => r.pass).length;
const fail = results.filter(r => !r.pass);
console.log(`\n═══════════════════════════════════════════════════`);
console.log(`  Reliability module tests: ${results.length} total, ${pass} passed, ${fail.length} failed`);
console.log(`═══════════════════════════════════════════════════`);
if (fail.length > 0) process.exit(1);
