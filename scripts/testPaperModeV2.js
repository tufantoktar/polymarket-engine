// ═══════════════════════════════════════════════════════════════════════
//  scripts/testPaperModeV2.js — Phase 2 paper-mode V2 validation tests
// ═══════════════════════════════════════════════════════════════════════
//  Goal: prove the CLOB V2 migration did not break paper mode and prove
//  paper mode never reaches the live order path.
//
//  Coverage:
//   - paper mode boots without PRIVATE_KEY
//   - paper mode boots without ENABLE_LIVE_TRADING=true
//   - paper mode ignores live-only collateral wrap config
//   - paper mode does not require the V2 SDK
//   - PolymarketClient.placeOrder in paper mode never instantiates the
//     V2 client (no `_getClobClient` call)
//   - paper order results are clearly marked paper/simulated
//   - private key never appears in any log line emitted from the paper
//     placement path
//   - LiveExecutionEngine + paper PolymarketClient round-trips a
//     simulated order through the FSM without touching a real CLOB
//   - live preflight remains strict (regression check)
//
//  No network, no real SDK use.
//
//  Run: node scripts/testPaperModeV2.js
// ═══════════════════════════════════════════════════════════════════════

import { runLivePreflight, validateConfig } from "../src/live/config/index.js";
import { PolymarketClient } from "../src/live/polymarketClient.js";
import { LiveExecutionEngine } from "../src/live/execution_engine/index.js";
import { LiveRiskEngine } from "../src/live/risk_engine/index.js";
import { Wallet } from "../src/live/wallet.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
};

const FAKE_TOKEN  = "98765432101234567890";

// ─── In-memory baseline paper config ───────────────────────────────────
const baseCfg = () => ({
  mode: "paper",
  enableLiveTrading: false,
  killSwitchEnabled: false,
  killSwitchFile: ".KILL",
  clob: {
    version: "v2",
    host: "https://clob.polymarket.com",
    gammaHost: "https://gamma-api.polymarket.com",
    chainId: 137,
    signatureType: 0,
    privateKey: null,
    funderAddress: null,
    apiKey: null,
    apiSecret: null,
    apiPassphrase: null,
    builderAddress: "",
  },
  collateral: { wrapEnabled: false, tokenAddress: "", onrampAddress: "" },
  retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  loop: { tickIntervalMs: 5000, marketRefreshMs: 15000, orderbookRefreshMs: 2000 },
  marketScanner: {
    maxActiveTokens: 20, defaultAdv: 1000, defaultTickSize: "0.01",
    minPrice: 0.01, maxPrice: 0.99,
  },
  signal: { historyMaxLen: 300, defaultVolatility: 0.02, defaultCategory: "x", regimeMinPoints: 30 },
  portfolio: { defaultCurrentDD: 0, defaultCbState: "closed" },
  filters: {
    minVolume24h: 0, maxSpread: 1, minDepth: 0,
    minHoursToResolution: 0, allowedCategories: [],
  },
  risk: {
    maxOrderQty: 1000, maxOrderNotional: 1000, maxPositionPerMarket: 10000,
    maxConcurrentOrders: 100, maxDailyLoss: 1000, maxDailyRejects: 1000,
    maxSlippageBps: 1000,
  },
  execution: {
    defaultOrderType: "GTC", limitOffsetTicks: 1,
    orderTimeoutMs: 60000, maxSlippageBps: 1000, minLiquidity: 0,
  },
  reconciliation: { intervalMs: 30000, runOnStart: false },
  recovery: { enabled: false, timeoutMs: 30000 },
  monitoring: {
    maxConsecutiveErrors: 100, maxApiFailureRate: 1, apiWindowSize: 100,
    stuckOrderTimeoutMs: 120000, healthLogIntervalMs: 15000,
    startupRecoveryEnabled: false,
  },
  snapshot: { enabled: false, filePath: "/tmp/x.json", intervalMs: 10000, loadOnStart: false },
  alerts: {
    noTradeAlertMs: 1, recoveryPendingGraceMs: 1,
    duplicateSignalThreshold: 1000, reconcileMismatchThreshold: 1000,
    cooldownMs: 1,
  },
  logging: { level: "error", dir: "/tmp", tradeLogFile: "t.jsonl", errorLogFile: "e.jsonl", decisionLogFile: "d.jsonl" },
});

// In-memory logger.
function captureLogger() {
  const events = [];
  const log = {
    info: (msg, data) => events.push({ level: "info", msg, data }),
    warn: (msg, data) => events.push({ level: "warn", msg, data }),
    error: (msg, data) => events.push({ level: "error", msg, data }),
    debug: (msg, data) => events.push({ level: "debug", msg, data }),
    trade: (msg, data) => events.push({ level: "trade", msg, data }),
    decision: (msg, data) => events.push({ level: "decision", msg, data }),
    errorEvent: (msg, err, data) => events.push({ level: "error_event", msg, err: err?.message, data }),
  };
  return { log, events };
}

// ═══════════════════════════════════════════════════════════════════════
//  1. Paper mode config validation — no live secrets required
// ═══════════════════════════════════════════════════════════════════════
{
  // Sanity: a fresh paper config without any live env should pass both
  // validateConfig and runLivePreflight.
  const cfg = baseCfg();
  cfg.clob.privateKey = null;
  cfg.clob.funderAddress = null;
  cfg.clob.apiKey = null;
  cfg.clob.apiSecret = null;
  cfg.clob.apiPassphrase = null;
  cfg.collateral.wrapEnabled = false;
  cfg.enableLiveTrading = false;

  let validateOk = true;
  try { validateConfig(cfg); } catch { validateOk = false; }
  assert("paper:validateConfig accepts paper with zero live env", validateOk);

  const r = runLivePreflight(cfg);
  assert("paper:preflight.ok=true for paper baseline", r.ok && r.errors.length === 0);
}

// ─── 1b. Paper mode ignores collateral wrap requirement ─────────────────
{
  const cfg = baseCfg();
  // Even if someone misconfigures wrap=true with no addresses, paper
  // mode must not be blocked by it. The preflight is live-only by design.
  cfg.collateral.wrapEnabled = true;
  cfg.collateral.tokenAddress = "";
  cfg.collateral.onrampAddress = "";
  const r = runLivePreflight(cfg);
  assert("paper:preflight ignores collateral wrap config", r.ok);
}

// ─── 1c. Paper mode tolerates ENABLE_LIVE_TRADING=true (no effect) ──────
{
  const cfg = baseCfg();
  cfg.enableLiveTrading = true; // No effect because mode=paper.
  const r = runLivePreflight(cfg);
  assert("paper:preflight ok even with ENABLE_LIVE_TRADING=true", r.ok);
}

// ═══════════════════════════════════════════════════════════════════════
//  2. PolymarketClient paper.placeOrder — never instantiates V2 client
// ═══════════════════════════════════════════════════════════════════════
{
  const cfg = baseCfg();
  // Inject a poison private key — if leakage happens we'll see it.
  cfg.clob.privateKey = "0xPAPER_LEAK_CANARY_PRIVATE_KEY_SHOULD_NEVER_APPEAR";
  const { log, events } = captureLogger();

  const client = new PolymarketClient(cfg, log);
  // Spy: replace _getClobClient with a sentinel that throws if called.
  let liveCtorCalled = false;
  client._getClobClient = async () => {
    liveCtorCalled = true;
    throw new Error("paper mode must not instantiate V2 client");
  };

  const resp = await client.placeOrder({
    tokenId: FAKE_TOKEN, side: "BUY", price: 0.42, size: 7,
  });
  assert("client:paper placeOrder did not call _getClobClient", liveCtorCalled === false);
  assert("client:paper placeOrder.success=true", resp.success === true);
  assert("client:paper placeOrder.paper=true", resp.paper === true);
  assert(
    "client:paper placeOrder.orderID has paper_ prefix",
    typeof resp.orderID === "string" && resp.orderID.startsWith("paper_"),
  );
  assert("client:paper placeOrder advertises clobVersion=v2", resp.clobVersion === "v2");

  // No log line — at any level — should contain the canary.
  const dump = JSON.stringify(events);
  assert("client:paper logs do not contain private key canary", !dump.includes("PAPER_LEAK_CANARY"));
}

// ─── 2b. paper.cancelOrder + cancelAllOrders are simulated ──────────────
{
  const cfg = baseCfg();
  const client = new PolymarketClient(cfg, captureLogger().log);
  client._getClobClient = async () => { throw new Error("must not be called"); };

  const c1 = await client.cancelOrder("paper_xyz");
  assert("client:paper cancelOrder simulated", c1.paper === true && c1.success === true);

  const cAll = await client.cancelAllOrders();
  assert("client:paper cancelAllOrders simulated", cAll.paper === true && cAll.success === true);

  const status = await client.getOrderStatus("paper_xyz");
  assert("client:paper getOrderStatus simulated", status.paper === true);

  const open = await client.getOpenOrders();
  assert("client:paper getOpenOrders empty", Array.isArray(open) && open.length === 0);

  const fills = await client.getFills();
  assert("client:paper getFills empty", Array.isArray(fills) && fills.length === 0);
}

// ─── 2c. Paper mode does not require the V2 SDK to be importable ───────
//
// We can't actually uninstall the V2 SDK at runtime, but we CAN prove
// the paper code path never reaches the import. The previous test
// (_getClobClient stub throws) already validated that. Here we double-
// check that the dynamic import statement isn't even executed by
// reading the paper-branch behaviour through a counter.
{
  const cfg = baseCfg();
  const client = new PolymarketClient(cfg, captureLogger().log);
  let importHit = 0;
  // The module under test only imports via _getClobClient; if it ever
  // adds another path to the live SDK, this stub will surface it.
  client._getClobClient = async () => { importHit++; throw new Error("blocked"); };
  await client.placeOrder({ tokenId: FAKE_TOKEN, side: "SELL", price: 0.55, size: 3 });
  assert("client:paper does not touch live SDK import path", importHit === 0);
}

// ═══════════════════════════════════════════════════════════════════════
//  3. LiveExecutionEngine round-trips a paper order through the FSM
// ═══════════════════════════════════════════════════════════════════════
{
  const cfg = baseCfg();
  const { log } = captureLogger();
  const client = new PolymarketClient(cfg, log);
  // Deterministic fake orderbook so risk gate has a book to inspect.
  client.getOrderbook = async () => ({
    tokenId: FAKE_TOKEN,
    bids: [{ price: 0.49, size: 100 }],
    asks: [{ price: 0.51, size: 100 }],
    bestBid: 0.49, bestAsk: 0.51, midPrice: 0.5, spread: 0.02,
    bidDepth: 49, askDepth: 51, fetchedAt: Date.now(),
  });
  // Trip the canary if the engine ever falls through to live.
  let liveEverTouched = false;
  client._getClobClient = async () => { liveEverTouched = true; throw new Error("paper exec must not touch live"); };

  const wallet = new Wallet(cfg, log);
  const risk = new LiveRiskEngine(cfg, log);
  const exec = new LiveExecutionEngine({ cfg, logger: log, client, wallet, risk });

  await exec.init();
  const result = await exec.placeOrder({
    source: "paper-test",
    marketId: "m_paper",
    tokenId: FAKE_TOKEN,
    side: "BUY",
    size: 5,
    price: 0.5,
    expectedPrice: 0.5,
    orderType: "GTC",
    signalTimestamp: 1700000000000,
  });

  assert("exec:paper placeOrder.success=true", result.success === true,
    JSON.stringify(result));
  assert("exec:paper externalOrderId starts with paper_",
    typeof result.externalOrderId === "string" && result.externalOrderId.startsWith("paper_"),
    String(result.externalOrderId));
  assert("exec:paper liveCtor never called", liveEverTouched === false);

  // Order is in store and in ORDER_PLACED state after paper submission.
  const stored = exec.orders.get(result.orderId);
  assert("exec:paper order is in ORDER_PLACED", stored?.state === "ORDER_PLACED",
    stored?.state || "missing");
  assert("exec:paper order has externalOrderId set", stored?.externalOrderId === result.externalOrderId);
}

// ─── 3b. Wallet snapshot in paper mode does not require ethers ──────────
{
  const cfg = baseCfg();
  const { log } = captureLogger();
  const wallet = new Wallet(cfg, log);
  const snap = await wallet.snapshot();
  assert("wallet:paper snapshot.paper=true", snap.paper === true);
  assert("wallet:paper snapshot.address starts with 0xPAPER", String(snap.address).startsWith("0xPAPER"));
  assert("wallet:paper approvals.usdc=true (stub)", snap.approvals.usdc === true);
  assert("wallet:paper approvals.ctf=true (stub)", snap.approvals.ctf === true);
}

// ═══════════════════════════════════════════════════════════════════════
//  4. Live preflight remains strict (regression: must not loosen)
// ═══════════════════════════════════════════════════════════════════════
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.enableLiveTrading = false; // explicit
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  const r = runLivePreflight(cfg);
  assert("regression:live without ENABLE_LIVE_TRADING still fails", !r.ok);
}
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.enableLiveTrading = true;
  cfg.clob.privateKey = null;
  const r = runLivePreflight(cfg);
  assert("regression:live without PRIVATE_KEY still fails", !r.ok);
}
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.enableLiveTrading = true;
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  cfg.clob.version = "v1";
  const r = runLivePreflight(cfg);
  assert("regression:live v1 still rejected", !r.ok);
}
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.enableLiveTrading = true;
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  cfg.clob.signatureType = 1;
  cfg.clob.funderAddress = null;
  const r = runLivePreflight(cfg);
  assert("regression:live non-EOA without funder still fails", !r.ok);
}
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.enableLiveTrading = true;
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  cfg.collateral.wrapEnabled = true;
  cfg.collateral.tokenAddress = "";
  cfg.collateral.onrampAddress = "";
  const r = runLivePreflight(cfg);
  assert("regression:live wrap-enabled without addresses still fails", !r.ok);
}

// ═══════════════════════════════════════════════════════════════════════
//  5. Logging shape — paper mode emits structured trade events
// ═══════════════════════════════════════════════════════════════════════
{
  const cfg = baseCfg();
  const { log, events } = captureLogger();
  const client = new PolymarketClient(cfg, log);
  client._getClobClient = async () => { throw new Error("nope"); };

  await client.placeOrder({ tokenId: FAKE_TOKEN, side: "BUY", price: 0.5, size: 1 });
  await client.cancelOrder("paper_x");

  const tradeEvents = events.filter(e => e.level === "trade");
  assert("logging:paper emits >= 2 trade events", tradeEvents.length >= 2);
  // Every paper-side trade event from the client carries paper:true on
  // the response (where applicable). The intent log path may not have
  // a response field (e.g. cancelOrder where we log just orderId).
  const placeEvent = tradeEvents.find(e => e.msg === "paper:placeOrder");
  assert(
    "logging:paper:placeOrder response.paper=true",
    !!placeEvent && placeEvent.data?.response?.paper === true,
  );
  // No event payload should serialize a `privateKey` key with a real
  // 32-byte value. We assert no event payload contains "privateKey":"0x...".
  const dump = JSON.stringify(events);
  assert("logging:no privateKey field appears in payloads", !/"privateKey":"0x[a-fA-F0-9]+"/.test(dump));
}

// ═══════════════════════════════════════════════════════════════════════
//  Summary
// ═══════════════════════════════════════════════════════════════════════
const pass = results.filter(r => r.pass).length;
const fail = results.filter(r => !r.pass);
console.log(`\n═══════════════════════════════════════════════════`);
console.log(`  Paper mode V2 tests: ${results.length} total, ${pass} passed, ${fail.length} failed`);
console.log(`═══════════════════════════════════════════════════`);
if (fail.length > 0) {
  for (const f of fail) console.log(`  FAIL: ${f.name} ${f.detail ? "(" + f.detail + ")" : ""}`);
  process.exit(1);
} else {
  console.log(`  All tests pass.\n`);
}
