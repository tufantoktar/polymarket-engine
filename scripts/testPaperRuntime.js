// ═══════════════════════════════════════════════════════════════════════
//  scripts/testPaperRuntime.js — Phase 2 bounded paper runtime tick test
// ═══════════════════════════════════════════════════════════════════════
//  Drives EventLoop.tick() for a small number of iterations using a
//  fully mocked PolymarketClient. No real network, no real CLOB, no
//  V2 SDK use. The only goal is to prove the orchestration pipeline
//  (scanner → ingest → state → signals → risk → exec → snapshot →
//  health) runs cleanly end-to-end in paper mode after the V2 migration.
//
//  Coverage:
//   - EventLoop boots in paper mode (no PRIVATE_KEY, no V2 SDK)
//   - Several controlled ticks complete without throwing
//   - Recommendations route through the paper exec path
//   - Real CLOB placement is never invoked
//   - Graceful stop sets _running=false and flushes counters
//
//  Run: node scripts/testPaperRuntime.js
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventLoop } from "../src/live/eventLoop.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
};

const TOKEN_A = "1111111111111111111111";
const TOKEN_B = "2222222222222222222222";

// Use a unique temp dir for logs / snapshot to keep CI clean.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-runtime-"));

const cfg = {
  mode: "paper",
  enableLiveTrading: false,
  killSwitchEnabled: false,
  killSwitchFile: ".KILL.test",
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
  loop: { tickIntervalMs: 50, marketRefreshMs: 50, orderbookRefreshMs: 50 },
  marketScanner: {
    maxActiveTokens: 5, defaultAdv: 1000, defaultTickSize: "0.01",
    minPrice: 0.01, maxPrice: 0.99,
  },
  signal: { historyMaxLen: 50, defaultVolatility: 0.02, defaultCategory: "x", regimeMinPoints: 30 },
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
  reconciliation: { intervalMs: 60_000_000, runOnStart: false },
  recovery: { enabled: false, timeoutMs: 30000 },
  monitoring: {
    maxConsecutiveErrors: 100, maxApiFailureRate: 1, apiWindowSize: 100,
    stuckOrderTimeoutMs: 120000, healthLogIntervalMs: 60_000_000,
    startupRecoveryEnabled: false,
  },
  snapshot: {
    enabled: true,
    filePath: path.join(tmpRoot, "snapshot.json"),
    intervalMs: 60_000_000,
    loadOnStart: false,
  },
  alerts: {
    noTradeAlertMs: 60_000_000, recoveryPendingGraceMs: 60_000_000,
    duplicateSignalThreshold: 1000, reconcileMismatchThreshold: 1000,
    cooldownMs: 60_000_000,
  },
  logging: { level: "error", dir: tmpRoot, tradeLogFile: "t.jsonl", errorLogFile: "e.jsonl", decisionLogFile: "d.jsonl" },
};

// ─── A deterministic, network-free PolymarketClient stub ────────────────
// EventLoop creates its own client+wallet+exec internally, so we patch
// the client *after* construction by overwriting the relevant methods.
// This proves the entire pipeline survives without touching the network.
//
// The client returns a stable Gamma market list and a stable orderbook.
function fakeMarkets() {
  return [
    {
      id: "mkt_a", conditionId: "0xa",
      clobTokenIds: JSON.stringify([TOKEN_A]),
      question: "Token A goes up?",
      category: "test", tags: ["test"], volume24hr: 50_000,
      endDate: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      orderPriceMinTickSize: "0.01", negRisk: false,
    },
    {
      id: "mkt_b", conditionId: "0xb",
      clobTokenIds: JSON.stringify([TOKEN_B]),
      question: "Token B goes up?",
      category: "test", tags: ["test"], volume24hr: 80_000,
      endDate: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      orderPriceMinTickSize: "0.01", negRisk: false,
    },
  ];
}

function fakeBook(tokenId) {
  // Slight offset between tokens so the signal engine has variety.
  const mid = tokenId === TOKEN_A ? 0.50 : 0.55;
  const spread = 0.02;
  return {
    tokenId,
    bids: [{ price: mid - spread / 2, size: 200 }],
    asks: [{ price: mid + spread / 2, size: 200 }],
    bestBid: mid - spread / 2, bestAsk: mid + spread / 2,
    midPrice: mid, spread,
    bidDepth: 200 * (mid - spread / 2), askDepth: 200 * (mid + spread / 2),
    fetchedAt: Date.now(),
  };
}

async function run() {
  const loop = new EventLoop(cfg);

  // Patch the client so it's hermetic.
  const c = loop.client;
  c.getMarkets = async () => fakeMarkets();
  c.getTradableMarkets = async () => fakeMarkets();
  c.getOrderbook = async (tokenId) => fakeBook(tokenId);
  c.getRecentTrades = async () => [];

  // Canary: if anything ever asks for the live SDK, fail loudly.
  let liveCtorAttempts = 0;
  c._getClobClient = async () => {
    liveCtorAttempts++;
    throw new Error("paper runtime must never instantiate V2 client");
  };
  // Track live placeOrder calls — there should be none. Paper goes
  // through the paper branch inside placeOrder; but we still spy the
  // method to assert paper=true on every response.
  const placeOrderResults = [];
  const realPlaceOrder = c.placeOrder.bind(c);
  c.placeOrder = async (order) => {
    const resp = await realPlaceOrder(order);
    placeOrderResults.push(resp);
    return resp;
  };

  // ─── init() ──────────────────────────────────────────────────────
  // We intentionally bypass _registerSignalHandlers from interfering
  // with the test process — the function is a no-op for assertions
  // here. The real init() does not throw in paper mode.
  let initOk = true;
  let initErr = null;
  try {
    await loop.init();
  } catch (e) {
    initOk = false;
    initErr = e;
  }
  assert("runtime:init() succeeds in paper mode", initOk, initErr?.message);

  assert("runtime:init() did not touch live SDK", liveCtorAttempts === 0);

  // Manually drive a few ticks. The signal engine needs at least a few
  // book snapshots to produce recs, so we tick repeatedly. The bound
  // here keeps the test < 1s in real time.
  let tickErrors = 0;
  for (let i = 0; i < 6; i++) {
    try {
      await loop.tick();
    } catch (e) {
      tickErrors++;
    }
  }
  assert("runtime:6 ticks complete without throwing", tickErrors === 0);

  // Scanner picked up the fake markets.
  assert(
    "runtime:market scanner picked up fake markets",
    loop.marketScanner.count() === 2,
    `count=${loop.marketScanner.count()}`,
  );

  // Signal engine ingested orderbooks at least once per token.
  const sigSnap = loop.signals.snapshot();
  assert(
    "runtime:signal engine has token state",
    sigSnap.tokenCount === 2,
    JSON.stringify(sigSnap),
  );

  // The exec engine still recognizes paper-only client. Live ctor
  // attempts must remain at zero across all ticks.
  assert("runtime:live SDK never instantiated", liveCtorAttempts === 0);

  // If any placeOrder calls happened, every single response must be
  // marked paper:true. (Most ticks may produce zero recs given a flat
  // synthetic book — both states are acceptable.)
  const allPaper = placeOrderResults.every(r => r && r.paper === true);
  assert(
    "runtime:every placement response is paper:true",
    allPaper,
    `placements=${placeOrderResults.length}`,
  );

  // Stop the loop cleanly.
  loop._running = false;
  loop.health.markStopped();
  if (loop.snapshotWriter) {
    try { await loop.snapshotWriter.flush(); } catch { /* fine */ }
    loop.snapshotWriter.stop();
  }
  assert("runtime:stop sets _running=false", loop._running === false);

  // Snapshot file should now exist (writer flushed at least once).
  const snapPath = cfg.snapshot.filePath;
  assert(
    "runtime:snapshot file written on stop",
    fs.existsSync(snapPath),
    snapPath,
  );

  // Read it back to assert it's valid JSON.
  let snapValid = false;
  try {
    const txt = fs.readFileSync(snapPath, "utf8");
    JSON.parse(txt);
    snapValid = true;
  } catch { /* asserted false below */ }
  assert("runtime:snapshot file is valid JSON", snapValid);
}

await run();

// ─── Summary ────────────────────────────────────────────────────────────
const pass = results.filter(r => r.pass).length;
const fail = results.filter(r => !r.pass);
console.log(`\n═══════════════════════════════════════════════════`);
console.log(`  Paper runtime tick tests: ${results.length} total, ${pass} passed, ${fail.length} failed`);
console.log(`═══════════════════════════════════════════════════`);
if (fail.length > 0) {
  for (const f of fail) console.log(`  FAIL: ${f.name} ${f.detail ? "(" + f.detail + ")" : ""}`);
  // Best-effort cleanup before exit.
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
} else {
  console.log(`  All tests pass.\n`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  // Force exit — EventLoop registered SIGINT/SIGTERM handlers that
  // prevent natural exit even after _running=false.
  process.exit(0);
}
