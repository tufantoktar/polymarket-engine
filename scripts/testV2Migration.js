// ═══════════════════════════════════════════════════════════════════════
//  scripts/testV2Migration.js — Phase 1 CLOB V2 migration tests
// ═══════════════════════════════════════════════════════════════════════
//  No test framework — simple assert-based script consistent with the
//  rest of scripts/test*.js.
//
//  Coverage:
//   - paper mode starts without PRIVATE_KEY
//   - live mode rejected when ENABLE_LIVE_TRADING != true
//   - live mode rejected when V2 SDK is missing
//   - live mode rejected when required V2 credentials/config are missing
//   - V2 order payload builder produces a deterministic shape
//   - BUY/SELL maker/taker amounts are correctly mapped
//   - invalid price/size is rejected before the SDK is touched
//   - private key is never printed in logs
//
//  Run: node scripts/testV2Migration.js
// ═══════════════════════════════════════════════════════════════════════

import {
  buildV2OrderPayload,
  computeV2Amounts,
  sanitizeOrderForLog,
  __test__ as v2Internals,
} from "../src/live/execution/v2OrderBuilder.js";
import { runLivePreflight, validateConfig } from "../src/live/config/index.js";
import { PolymarketClient } from "../src/live/polymarketClient.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
};

const FAKE_MAKER  = "0x1111111111111111111111111111111111111111";
const FAKE_SIGNER = "0x2222222222222222222222222222222222222222";
const FAKE_TOKEN  = "12345678901234567890";

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
    maxOrderQty: 100, maxOrderNotional: 100, maxPositionPerMarket: 100,
    maxConcurrentOrders: 10, maxDailyLoss: 50, maxDailyRejects: 20,
    maxSlippageBps: 50,
  },
  execution: {
    defaultOrderType: "GTC", limitOffsetTicks: 1,
    orderTimeoutMs: 60000, maxSlippageBps: 50, minLiquidity: 0,
  },
  reconciliation: { intervalMs: 30000, runOnStart: false },
  recovery: { enabled: false, timeoutMs: 30000 },
  monitoring: {
    maxConsecutiveErrors: 5, maxApiFailureRate: 0.5, apiWindowSize: 20,
    stuckOrderTimeoutMs: 120000, healthLogIntervalMs: 15000,
    startupRecoveryEnabled: false,
  },
  snapshot: { enabled: false, filePath: "/tmp/x.json", intervalMs: 10000, loadOnStart: false },
  alerts: {
    noTradeAlertMs: 1, recoveryPendingGraceMs: 1,
    duplicateSignalThreshold: 1, reconcileMismatchThreshold: 1,
    cooldownMs: 1,
  },
  logging: { level: "error", dir: "/tmp", tradeLogFile: "t.jsonl", errorLogFile: "e.jsonl", decisionLogFile: "d.jsonl" },
});

// In-memory logger for capture in tests.
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

// ─── 1. Preflight — paper mode is always allowed ───────────────────────
{
  const cfg = baseCfg();
  cfg.mode = "paper";
  const r = runLivePreflight(cfg);
  assert("preflight: paper mode ok with no private key", r.ok, JSON.stringify(r.errors));
  validateConfig(cfg); // Should not throw.
}

// ─── 2. Live mode: ENABLE_LIVE_TRADING gate ────────────────────────────
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.enableLiveTrading = false;
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  const r = runLivePreflight(cfg);
  assert("preflight: live without ENABLE_LIVE_TRADING fails", !r.ok);
  assert(
    "preflight: error message mentions ENABLE_LIVE_TRADING",
    r.errors.some(e => /ENABLE_LIVE_TRADING/.test(e)),
  );
}

// ─── 3. Live mode: missing private key fails ───────────────────────────
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.enableLiveTrading = true;
  cfg.clob.privateKey = null;
  const r = runLivePreflight(cfg);
  assert("preflight: missing PRIVATE_KEY fails", !r.ok);
  assert(
    "preflight: error mentions PRIVATE_KEY",
    r.errors.some(e => /PRIVATE_KEY/.test(e)),
  );
}

// ─── 4. Live mode: V1 version is rejected in Phase 1 ───────────────────
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.enableLiveTrading = true;
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  cfg.clob.version = "v1";
  const r = runLivePreflight(cfg);
  assert("preflight: v1 is rejected", !r.ok);
  assert(
    "preflight: error mentions v2",
    r.errors.some(e => /v2/.test(e)),
  );
}

// ─── 5. Live mode: non-EOA signature requires funder ───────────────────
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.enableLiveTrading = true;
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  cfg.clob.signatureType = 1;
  cfg.clob.funderAddress = null;
  const r = runLivePreflight(cfg);
  assert("preflight: non-EOA without FUNDER_ADDRESS fails", !r.ok);
  assert(
    "preflight: error mentions FUNDER_ADDRESS",
    r.errors.some(e => /FUNDER_ADDRESS/.test(e)),
  );
}

// ─── 6. Live mode: collateral wrap requires token + onramp ─────────────
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.enableLiveTrading = true;
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  cfg.collateral.wrapEnabled = true;
  cfg.collateral.tokenAddress = "";
  cfg.collateral.onrampAddress = "";
  const r = runLivePreflight(cfg);
  assert("preflight: wrap enabled requires token + onramp", !r.ok);
  assert(
    "preflight: error mentions COLLATERAL_TOKEN_ADDRESS",
    r.errors.some(e => /COLLATERAL_TOKEN_ADDRESS/.test(e)),
  );
  assert(
    "preflight: error mentions COLLATERAL_ONRAMP_ADDRESS",
    r.errors.some(e => /COLLATERAL_ONRAMP_ADDRESS/.test(e)),
  );
}

// ─── 7. Live mode: kill switch active fails ────────────────────────────
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.enableLiveTrading = true;
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  cfg.killSwitchEnabled = true;
  const r = runLivePreflight(cfg);
  assert("preflight: kill switch active fails", !r.ok);
  assert(
    "preflight: kill switch error string",
    r.errors.some(e => /Kill switch/.test(e)),
  );
}

// ─── 8. Happy live preflight ───────────────────────────────────────────
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.enableLiveTrading = true;
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  const r = runLivePreflight(cfg);
  assert("preflight: happy live config passes", r.ok, JSON.stringify(r.errors));
}

// ─── 9. v2OrderBuilder: BUY mapping ────────────────────────────────────
{
  const p = buildV2OrderPayload({
    tokenId: FAKE_TOKEN,
    side: "BUY",
    price: 0.50,
    size: 100,
    maker: FAKE_MAKER,
    signer: FAKE_SIGNER,
    signatureType: 0,
    salt: "1000",
    now: () => 1_700_000_000_000,
  });
  assert("builder: BUY makerAmount = price*size in USDC base units", p.makerAmount === "50000000");
  assert("builder: BUY takerAmount = size in share base units", p.takerAmount === "100000000");
  assert("builder: BUY side preserved", p.side === "BUY");
  assert("builder: deterministic salt honored", p.salt === "1000");
  assert("builder: timestamp from now()", p.timestamp === "1700000000");
  assert("builder: tokenId preserved", p.tokenId === FAKE_TOKEN);
  assert("builder: signatureType preserved", p.signatureType === 0);
  assert("builder: no V1 nonce field", !("nonce" in p));
  assert("builder: no V1 feeRateBps field", !("feeRateBps" in p));
  assert("builder: no V1 taker field", !("taker" in p));
}

// ─── 10. v2OrderBuilder: SELL mapping ──────────────────────────────────
{
  const p = buildV2OrderPayload({
    tokenId: FAKE_TOKEN,
    side: "SELL",
    price: 0.50,
    size: 100,
    maker: FAKE_MAKER,
    signer: FAKE_SIGNER,
    signatureType: 0,
    salt: "2000",
    now: () => 1_700_000_000_000,
  });
  assert("builder: SELL makerAmount = size in share base units", p.makerAmount === "100000000");
  assert("builder: SELL takerAmount = price*size in USDC base units", p.takerAmount === "50000000");
  assert("builder: SELL side preserved", p.side === "SELL");
}

// ─── 11. v2OrderBuilder: deterministic across two calls ─────────────────
{
  const args = {
    tokenId: FAKE_TOKEN, side: "BUY", price: 0.37, size: 23,
    maker: FAKE_MAKER, signer: FAKE_SIGNER, signatureType: 0,
    salt: "fixed-salt", now: () => 1_650_000_000_000,
  };
  const a = buildV2OrderPayload(args);
  const b = buildV2OrderPayload(args);
  assert("builder: deterministic — equal payloads", JSON.stringify(a) === JSON.stringify(b));
}

// ─── 12. v2OrderBuilder: invalid inputs rejected ───────────────────────
{
  const valid = {
    tokenId: FAKE_TOKEN, side: "BUY", price: 0.5, size: 10,
    maker: FAKE_MAKER, signer: FAKE_SIGNER, signatureType: 0,
    salt: "1",
  };
  let threw;

  threw = false;
  try { buildV2OrderPayload({ ...valid, side: "buy" }); } catch { threw = true; }
  assert("builder: rejects lowercase side", threw);

  threw = false;
  try { buildV2OrderPayload({ ...valid, price: 0 }); } catch { threw = true; }
  assert("builder: rejects price=0", threw);

  threw = false;
  try { buildV2OrderPayload({ ...valid, price: 1 }); } catch { threw = true; }
  assert("builder: rejects price=1", threw);

  threw = false;
  try { buildV2OrderPayload({ ...valid, price: -0.1 }); } catch { threw = true; }
  assert("builder: rejects negative price", threw);

  threw = false;
  try { buildV2OrderPayload({ ...valid, size: 0 }); } catch { threw = true; }
  assert("builder: rejects size=0", threw);

  threw = false;
  try { buildV2OrderPayload({ ...valid, size: -5 }); } catch { threw = true; }
  assert("builder: rejects negative size", threw);

  threw = false;
  try { buildV2OrderPayload({ ...valid, maker: "0xnotanaddress" }); } catch { threw = true; }
  assert("builder: rejects malformed maker", threw);

  threw = false;
  try { buildV2OrderPayload({ ...valid, signatureType: 9 }); } catch { threw = true; }
  assert("builder: rejects unknown signatureType", threw);

  threw = false;
  try { buildV2OrderPayload({ ...valid, tokenId: "" }); } catch { threw = true; }
  assert("builder: rejects empty tokenId", threw);
}

// ─── 13. v2OrderBuilder: builder field passthrough ─────────────────────
{
  const builder = "0x9999999999999999999999999999999999999999";
  const p = buildV2OrderPayload({
    tokenId: FAKE_TOKEN, side: "BUY", price: 0.5, size: 10,
    maker: FAKE_MAKER, signer: FAKE_SIGNER, signatureType: 0,
    salt: "1", builder,
  });
  assert("builder: builder field attached", p.builder === builder);

  const p2 = buildV2OrderPayload({
    tokenId: FAKE_TOKEN, side: "BUY", price: 0.5, size: 10,
    maker: FAKE_MAKER, signer: FAKE_SIGNER, signatureType: 0,
    salt: "1",
  });
  assert("builder: builder field omitted when empty", !("builder" in p2));
}

// ─── 14. computeV2Amounts: small-fraction precision ─────────────────────
{
  // 0.1234 * 7 = 0.8638 USDC = 863800 base units
  const r = computeV2Amounts({ side: "BUY", price: 0.1234, size: 7 });
  assert("amounts: BUY 0.1234*7 = 863800", r.makerAmount === "863800",
    `got ${r.makerAmount}`);
  assert("amounts: BUY size 7 → 7000000", r.takerAmount === "7000000");
}

// ─── 15. sanitizeOrderForLog: strips secrets ────────────────────────────
{
  const dirty = {
    side: "BUY",
    privateKey: "0xshouldnotleak",
    private_key: "leakage",
    secret: "abc",
    passphrase: "xyz",
    signature: "0xff",
    sig: "raw",
    tokenId: "x",
  };
  const clean = sanitizeOrderForLog(dirty);
  assert("sanitize: privateKey redacted", clean.privateKey === "[REDACTED]");
  assert("sanitize: private_key redacted", clean.private_key === "[REDACTED]");
  assert("sanitize: secret redacted", clean.secret === "[REDACTED]");
  assert("sanitize: passphrase redacted", clean.passphrase === "[REDACTED]");
  assert("sanitize: signature redacted", clean.signature === "[REDACTED]");
  assert("sanitize: sig redacted", clean.sig === "[REDACTED]");
  assert("sanitize: side preserved", clean.side === "BUY");
  assert("sanitize: tokenId preserved", clean.tokenId === "x");
}

// ─── 16. PolymarketClient paper.placeOrder doesn't load V2 SDK ─────────
{
  const cfg = baseCfg();
  const { log, events } = captureLogger();
  const client = new PolymarketClient(cfg, log);
  const SECRET_PK = "0xDEADBEEF" + "a".repeat(56);
  cfg.clob.privateKey = SECRET_PK;
  const resp = await client.placeOrder({
    tokenId: FAKE_TOKEN, side: "BUY", price: 0.5, size: 10,
  });
  assert("client: paper placeOrder returns synthetic id", typeof resp.orderID === "string" && resp.orderID.startsWith("paper_"));
  assert("client: paper placeOrder marks paper=true", resp.paper === true);
  assert("client: paper placeOrder advertises clobVersion v2", resp.clobVersion === "v2");

  const dump = JSON.stringify(events);
  assert("client: private key never appears in logs", !dump.includes(SECRET_PK));
  assert("client: env private key never appears in logs", !dump.includes("DEADBEEF"));
}

// ─── 17. PolymarketClient.placeOrder rejects bad inputs (paper) ─────────
{
  const cfg = baseCfg();
  const client = new PolymarketClient(cfg, captureLogger().log);
  let threw;

  threw = false;
  try { await client.placeOrder({ tokenId: "", side: "BUY", price: 0.5, size: 10 }); } catch { threw = true; }
  assert("client: rejects empty tokenId", threw);

  threw = false;
  try { await client.placeOrder({ tokenId: FAKE_TOKEN, side: "MAYBE", price: 0.5, size: 10 }); } catch { threw = true; }
  assert("client: rejects bad side", threw);

  threw = false;
  try { await client.placeOrder({ tokenId: FAKE_TOKEN, side: "BUY", price: 1.5, size: 10 }); } catch { threw = true; }
  assert("client: rejects price > 1", threw);

  threw = false;
  try { await client.placeOrder({ tokenId: FAKE_TOKEN, side: "BUY", price: 0.5, size: -1 }); } catch { threw = true; }
  assert("client: rejects negative size", threw);
}

// ─── 18. PolymarketClient live without V2 SDK gives a clear error ──────
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.clob.version = "v2";
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  const client = new PolymarketClient(cfg, captureLogger().log);
  let err;
  try {
    await client.placeOrder({ tokenId: FAKE_TOKEN, side: "BUY", price: 0.5, size: 10 });
  } catch (e) {
    err = e;
  }
  // The premise has to be stated rather than assumed. This assertion
  // used to demand an error naming the package, which only holds when
  // the package is absent - it is an optionalDependency, so in any
  // environment that installed it the test failed for a reason unrelated
  // to what it was checking. It spent months red while carrying the
  // KI-001 evidence, which is how a broken constructor stayed hidden.
  //
  // The invariant that matters in both worlds is the same: live
  // placement never quietly succeeds.
  let sdkPresent = true;
  try { await import("@polymarket/clob-client-v2"); } catch { sdkPresent = false; }

  assert("client: live placement without working credentials throws", !!err,
    `sdkPresent=${sdkPresent}`);
  if (!sdkPresent) {
    assert(
      "client: with the SDK absent, the error names the package",
      err && /clob-client-v2/.test(err.message),
      err?.message,
    );
  } else {
    assert(
      "client: with the SDK present, the failure is not a malformed call",
      err && !/Cannot read properties of undefined \(reading 'endsWith'\)/.test(err.message),
      err?.message,
    );
  }
}

// ─── 19. PolymarketClient live with v1 version errors ──────────────────
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.clob.version = "v1";
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  const client = new PolymarketClient(cfg, captureLogger().log);
  let err;
  try {
    await client.placeOrder({ tokenId: FAKE_TOKEN, side: "BUY", price: 0.5, size: 10 });
  } catch (e) {
    err = e;
  }
  assert("client: live with v1 version is blocked", !!err);
  assert(
    "client: error mentions Phase 1 / v2",
    err && /v2/.test(err.message),
    err?.message,
  );
}

// ─── 20. Internal: toBaseUnits sanity ──────────────────────────────────
{
  const t = v2Internals.toBaseUnits;
  assert("internal: 1 → 1000000", t(1) === "1000000");
  assert("internal: 0.5 → 500000", t(0.5) === "500000");
  assert("internal: 0.000001 → 1", t(0.000001) === "1");
  let threw = false;
  try { t(0); } catch { threw = true; }
  assert("internal: rejects 0", threw);
}

// ─── 24. KI-001: the SDK constructor is called with the right shape ────
//
//  v1.1.0 takes a SINGLE options object. It was being called
//  positionally, so host arrived as undefined and the SDK threw
//  "Cannot read properties of undefined (reading 'endsWith')" before any
//  request left the process. Live placement had therefore never worked.
//
//  It survived because this path could not be reached from a test: the
//  SDK was imported directly, so exercising it meant having the SDK, a
//  key and a network. The import is now injectable, and this asserts the
//  call shape against a fake with no network involved.
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.clob.version = "v2";
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  cfg.clob.chainId = 137;
  cfg.clob.host = "https://clob.example.test";
  cfg.clob.signatureType = 0;
  cfg.clob.apiKey = cfg.clob.apiSecret = cfg.clob.apiPassphrase = "";

  const ctorArgs = [];
  const derived = { key: "k", secret: "s", passphrase: "p" };
  let deriveCalls = 0, createCalls = 0;

  class FakeClob {
    constructor(...args) {
      ctorArgs.push(args);
      this.host = args[0]?.host;
    }
    async deriveApiKey() { deriveCalls++; return derived; }
    async createApiKey() { createCalls++; return { key: "new" }; }
  }

  const client = new PolymarketClient(cfg, captureLogger().log);
  client._importV2 = async () => ({ ClobClient: FakeClob });

  let built = null, err = null;
  try { built = await client._getClobClient(); } catch (e) { err = e; }

  assert("KI-001: client is constructed without throwing", !err, err?.message);
  assert("KI-001: constructor takes exactly one argument",
    ctorArgs.every(a => a.length === 1), JSON.stringify(ctorArgs.map(a => a.length)));
  assert("KI-001: that argument is an options object",
    ctorArgs.every(a => a[0] && typeof a[0] === "object" && !Array.isArray(a[0])));

  const final = ctorArgs[ctorArgs.length - 1]?.[0] || {};
  assert("KI-001: host is passed, not undefined", final.host === cfg.clob.host,
    String(final.host));
  assert("KI-001: the chain field is named chain, not chainId",
    final.chain === 137 && final.chainId === undefined,
    JSON.stringify({ chain: final.chain, chainId: final.chainId }));
  assert("KI-001: the signer is passed", !!final.signer);
  assert("KI-001: derived creds are passed in", final.creds === derived);
  assert("KI-001: signatureType is passed", final.signatureType === 0);

  // Deriving is deterministic from the wallet; creating mints a new
  // credential server-side on every call. Preferring derive keeps a
  // restart from leaving a trail of orphaned API keys.
  assert("KI-001: credentials are derived, not created", deriveCalls === 1 && createCalls === 0,
    `derive=${deriveCalls} create=${createCalls}`);
  assert("KI-001: the built client is returned and cached",
    built instanceof FakeClob && (await client._getClobClient()) === built);
}

// ─── 25. Explicit credentials skip derivation entirely ─────────────────
{
  const cfg = baseCfg();
  cfg.mode = "live";
  cfg.clob.version = "v2";
  cfg.clob.privateKey = "0x" + "a".repeat(64);
  cfg.clob.apiKey = "K"; cfg.clob.apiSecret = "S"; cfg.clob.apiPassphrase = "P";

  const ctorArgs = [];
  let deriveCalls = 0;
  class FakeClob {
    constructor(o) { ctorArgs.push(o); }
    async deriveApiKey() { deriveCalls++; return {}; }
  }
  const client = new PolymarketClient(cfg, captureLogger().log);
  client._importV2 = async () => ({ ClobClient: FakeClob });
  await client._getClobClient();

  assert("KI-001: supplied credentials are used as-is",
    ctorArgs.length === 1 && ctorArgs[0].creds?.key === "K");
  assert("KI-001: no bootstrap client is built when creds are supplied",
    deriveCalls === 0, `derive=${deriveCalls}`);
}

// ─── Summary ────────────────────────────────────────────────────────────
const pass = results.filter(r => r.pass).length;
const fail = results.filter(r => !r.pass);
console.log(`\n═══════════════════════════════════════════════════`);
console.log(`  V2 migration tests: ${results.length} total, ${pass} passed, ${fail.length} failed`);
console.log(`═══════════════════════════════════════════════════`);
if (fail.length > 0) {
  for (const f of fail) console.log(`  FAIL: ${f.name} ${f.detail ? "(" + f.detail + ")" : ""}`);
  process.exit(1);
} else {
  console.log(`  All tests pass.\n`);
}
