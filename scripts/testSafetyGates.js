#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/testSafetyGates.js — the financial contract, in one place
// ═══════════════════════════════════════════════════════════════════════
//  Layer 4 of the test design. Some of these invariants are checked
//  elsewhere; they are restated here because a safety property scattered
//  across five suites is a property nobody owns.
//
//  Most assertions here are NEGATIVE facts: the exchange was never
//  contacted, no second order was submitted, the key never reached a log
//  line. Negative facts need a spy that records everything, which is why
//  the engine's dependency injection is used rather than mocking modules.
//
//  Some of these are EXPECTED TO FAIL on first run. That is the design.
//  A test written after the fix proves nothing about what the fix
//  changed. If one fails, report it - do not relax it.
//
//  No network. No real client. No orders.
// ═══════════════════════════════════════════════════════════════════════
import { LiveRiskEngine } from "../src/live/risk_engine/index.js";
import { LIVE_CONFIG } from "../src/live/config/index.js";
import { PolymarketClient } from "../src/live/polymarketClient.js";
import { LiveExecutionEngine } from "../src/live/execution_engine/index.js";
import { KillSwitch } from "../src/live/monitoring/killSwitch.js";
import { runLivePreflight } from "../src/live/config/index.js";
import { DEFAULT_PRICE_BAND, isTradablePrice } from "../src/engine/priceBand.js";

const results = [];
const assert = (id, name, cond, detail = "") => {
  results.push({ id, name, pass: !!cond, detail });
  if (!cond) console.log(`  FAIL ${id} ${name}${detail ? " — " + detail : ""}`);
};

const silentLog = {
  info: () => {}, warn: () => {}, debug: () => {}, error: () => {},
  errorEvent: () => {}, decision: () => {}, trade: () => {},
};

function testCfg(over = {}) {
  const c = structuredClone(LIVE_CONFIG);
  Object.assign(c.risk, over.risk || {});
  Object.assign(c.filters, over.filters || {});
  return c;
}
const riskEngine = over => new LiveRiskEngine(testCfg(over), silentLog);

// ─────────────────────────────────────────────────────────────────────
//  S4 — invalid price rejected before anything else happens
//
//  A NaN price makes notional NaN, and every comparison against NaN is
//  false, so a malformed order can walk past a chain of numeric guards
//  untouched. This is why the assertion is written against the contract
//  ("rejected") rather than against the current implementation.
// ─────────────────────────────────────────────────────────────────────
{
  const r = riskEngine();
  for (const [label, price] of [
    ["zero", 0], ["negative", -0.5], ["one", 1], ["above one", 1.5],
    ["NaN", NaN], ["string", "0.5"], ["undefined", undefined],
  ]) {
    const out = r.checkOrder({ size: 10, price });
    assert("S4", `invalid price rejected (${label})`, out.ok === false,
      `price=${String(price)} -> ${JSON.stringify(out)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  S5 — invalid size rejected
// ─────────────────────────────────────────────────────────────────────
{
  const r = riskEngine();
  for (const [label, size] of [
    ["zero", 0], ["negative", -10], ["NaN", NaN], ["string", "10"],
    ["undefined", undefined], ["Infinity", Infinity],
  ]) {
    const out = r.checkOrder({ size, price: 0.5 });
    assert("S5", `invalid size rejected (${label})`, out.ok === false,
      `size=${String(size)} -> ${JSON.stringify(out)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  S5b — a malformed side is rejected, not reinterpreted
//
//  The engine computes direction as (side === "BUY" ? +size : -size), so
//  anything that is not exactly "BUY" becomes a SELL. A missing side, or
//  a lowercase one, silently reverses the trade.
// ─────────────────────────────────────────────────────────────────────
{
  const r = riskEngine();
  for (const [label, side] of [
    ["missing", undefined], ["lowercase buy", "buy"], ["null", null],
    ["LONG", "LONG"], ["empty", ""],
  ]) {
    const out = r.checkOrder({ size: 10, price: 0.5, currentPosition: 0, side });
    assert("S5b", `malformed side rejected (${label})`, out.ok === false,
      `side=${String(side)} -> treated as ${side === "BUY" ? "BUY" : "SELL"}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  S6 — position cap holds under fuzzing
//
//  A cap that holds for the cases someone thought of is not a cap. This
//  throws random orders at random existing positions and asserts the
//  projected position never exceeds the limit.
// ─────────────────────────────────────────────────────────────────────
{
  const cap = 500;
  const r = riskEngine({ risk: { maxPositionPerMarket: cap, maxOrderQty: 10_000, maxOrderNotional: 1e9 } });
  let worst = 0, breaches = 0;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 2000; i++) {
    const currentPosition = Math.floor(rnd() * cap * 2) - cap;
    const size = Math.floor(rnd() * 1000) + 1;
    const price = 0.05 + rnd() * 0.9;
    const side = rnd() < 0.5 ? "BUY" : "SELL";
    const out = r.checkOrder({ size, price, currentPosition, side });
    if (!out.ok) continue;
    // Projected exactly as the engine defines it. An earlier version of
    // this test omitted side and measured a promise the engine never
    // made, which produced a false defect report.
    const projected = Math.abs(
      currentPosition + (side === "BUY" ? out.adjustedSize : -out.adjustedSize));
    if (projected > worst) worst = projected;
    if (projected > cap) breaches++;
  }
  assert("S6", "position cap never exceeded under 2000 fuzzed orders",
    breaches === 0, `breaches=${breaches} worst=${worst} cap=${cap}`);
}

// ─────────────────────────────────────────────────────────────────────
//  S7 — notional cap holds after the engine clamps the size
// ─────────────────────────────────────────────────────────────────────
{
  const maxNotional = 100;
  const r = riskEngine({ risk: { maxOrderNotional: maxNotional, maxOrderQty: 10_000 } });
  let breaches = 0, checked = 0;
  for (let size = 1; size <= 400; size += 7) {
    for (const price of [0.05, 0.2, 0.5, 0.8, 0.95]) {
      const out = r.checkOrder({ size, price, side: "BUY" });
      if (!out.ok) continue;
      checked++;
      if (out.adjustedSize * price > maxNotional + 1e-9) breaches++;
    }
  }
  assert("S7", "notional cap holds after clamping", breaches === 0,
    `breaches=${breaches} of ${checked}`);
}

// ─────────────────────────────────────────────────────────────────────
//  S8 — concurrent order cap
// ─────────────────────────────────────────────────────────────────────
{
  const maxConc = 3;
  const r = riskEngine({ risk: { maxConcurrentOrders: maxConc } });
  for (let i = 0; i < maxConc; i++) r.trackOrder(`o${i}`);
  const out = r.checkOrder({ size: 10, price: 0.5, side: "BUY" });
  assert("S8", "order beyond the concurrency cap is rejected",
    out.ok === false && String(out.reason).includes("concurrent"),
    JSON.stringify(out));
  r.untrackOrder("o0");
  assert("S8", "freeing a slot allows the next order",
    r.checkOrder({ size: 10, price: 0.5, side: "BUY" }).ok === true);
}

// ─────────────────────────────────────────────────────────────────────
//  S16 / S17 — daily limits halt trading
// ─────────────────────────────────────────────────────────────────────
{
  const r = riskEngine({ risk: { maxDailyLoss: 50 } });
  assert("S16", "engine starts unhalted", r.isHalted() === false);
  r.recordRealizedPnl(-50);
  assert("S16", "daily loss limit halts", r.isHalted() === true);
  assert("S16", "a halted engine rejects orders",
    r.checkOrder({ size: 10, price: 0.5, side: "BUY" }).ok === false);
  r.recordRealizedPnl(+1000);
  assert("S3", "a halt does not clear itself on later success",
    r.isHalted() === true);
}
{
  const r = riskEngine({ risk: { maxDailyRejects: 5 } });
  for (let i = 0; i < 5; i++) r.recordReject("test");
  assert("S17", "daily reject limit halts", r.isHalted() === true);
}

// ─────────────────────────────────────────────────────────────────────
//  S10 — a retry must never place a second order
//
//  polymarketClient.placeOrder wraps createAndPostOrder in withRetry.
//  That call signs and posts a NEW order every time, with a fresh salt
//  and no client-side idempotency key, so the exchange has no way to
//  recognise the second attempt as the same intent.
//
//  The dangerous case is not a rejected order. It is an ACCEPTED one
//  whose response never arrives: the exchange has the position, the
//  client sees a timeout, isRetryable says ETIMEDOUT is transient, and
//  a second real order goes out.
//
//  The mock therefore records the call BEFORE throwing — exactly the
//  order of events on the wire.
//
//  This assertion is expected to fail until the hazard is fixed. Do not
//  relax it; a test written after the fix proves nothing about it.
// ─────────────────────────────────────────────────────────────────────
{
  const liveCfg = structuredClone(LIVE_CONFIG);
  liveCfg.mode = "live";
  // A maker address is needed to build the order intent. No key, no
  // signer, no network - the point of the test is what happens after
  // the order is already on the wire.
  liveCfg.clob.funderAddress = "0x" + "11".repeat(20);
  liveCfg.clob.signatureType = 0;
  const client = new PolymarketClient(liveCfg, silentLog);

  let submissions = 0;
  // Pre-seeding _clob short-circuits _getClobClient, so no SDK, no
  // signer and no key are needed to exercise the retry path.
  client._clob = {
    createAndPostOrder: async () => {
      submissions++;                       // the exchange now has it
      const e = new Error("socket hang up");
      e.code = "ETIMEDOUT";                // ...and the answer is lost
      throw e;
    },
  };

  let threw = null;
  try {
    await client.placeOrder({ tokenId: "tok", side: "BUY", price: 0.5, size: 10 });
  } catch (e) { threw = e; }

  assert("S10", "a timed-out submission is not retried into a second order",
    submissions === 1,
    `submissions=${submissions} — each one is a real order on the exchange`);
  assert("S10", "the caller still learns the submission failed", threw !== null);
  // Not retrying is only half the fix. The caller has to be told the
  // order may exist anyway, or it will book a clean failure for
  // something that is actually an open position.
  assert("S10", "the failure is flagged as uncertain, not as a clean reject",
    threw?.submitUncertain === true, `submitUncertain=${threw?.submitUncertain}`);
}

// ═════════════════════════════════════════════════════════════════════
//  Spy client — records every call so negative facts can be asserted
//
//  "The exchange was never contacted" cannot be checked by looking at a
//  return value. It needs something that would have noticed.
// ═════════════════════════════════════════════════════════════════════
const BOOK = {
  bids: [{ price: 0.49, size: 5000 }], asks: [{ price: 0.51, size: 5000 }],
  bestBid: 0.49, bestAsk: 0.51, midPrice: 0.5, spread: 0.02,
  bidDepth: 2450, askDepth: 2550,
};
function spyClient({ throwOnPlace = null } = {}) {
  const calls = { getOrderbook: [], placeOrder: [], cancelOrder: [] };
  return {
    calls,
    async getOrderbook(t) { calls.getOrderbook.push(t); return BOOK; },
    async placeOrder(o) {
      calls.placeOrder.push(o);
      if (throwOnPlace) throw throwOnPlace;
      return { success: true, orderID: `ext_${calls.placeOrder.length}`, status: "resting" };
    },
    async cancelOrder(id) { calls.cancelOrder.push(id); return { success: true }; },
    async getOpenOrders() { return []; },
  };
}
const walletStub = {
  async snapshot() { return { address: "0x" + "22".repeat(20), usdc: 1000, approvals: true, paper: true }; },
};
const goodOrder = (over = {}) => ({
  tokenId: "tok1", side: "BUY", price: 0.5, size: 10,
  signalTimestamp: 1_700_000_000_000, ...over,
});
function engineWith(deps = {}) {
  return new LiveExecutionEngine({
    cfg: testCfg(), logger: silentLog, client: spyClient(), wallet: walletStub, ...deps,
  });
}

// ─────────────────────────────────────────────────────────────────────
//  S1 — a risk rejection means the exchange is never contacted
// ─────────────────────────────────────────────────────────────────────
{
  const client = spyClient();
  const risk = new LiveRiskEngine(testCfg(), silentLog);
  risk.emergencyStop("test_halt");
  const eng = engineWith({ client, risk });

  const out = await eng.placeOrder(goodOrder());
  assert("S1", "a risk-rejected order returns unsuccessful", out.success === false,
    JSON.stringify(out));
  assert("S1", "a risk-rejected order never reaches the exchange",
    client.calls.placeOrder.length === 0,
    `placeOrder calls=${client.calls.placeOrder.length}`);
}

// ─────────────────────────────────────────────────────────────────────
//  S2 — a halted kill switch stops execution before anything else
// ─────────────────────────────────────────────────────────────────────
{
  const client = spyClient();
  const killSwitch = { isHalted: () => true, getReason: () => "test", recordApiSuccess() {}, recordApiFailure() {}, recordOrderProgress() {} };
  const eng = engineWith({ client, killSwitch });

  const out = await eng.placeOrder(goodOrder());
  assert("S2", "a halted kill switch refuses the order", out.success === false && out.reason === "halted",
    JSON.stringify(out));
  assert("S2", "a halted kill switch contacts no exchange at all",
    client.calls.placeOrder.length === 0 && client.calls.getOrderbook.length === 0,
    `place=${client.calls.placeOrder.length} book=${client.calls.getOrderbook.length}`);
}

// ─────────────────────────────────────────────────────────────────────
//  S3 — a halt does not clear itself
//
//  The failure mode is a switch that trips on a bad minute and untrips
//  on the next good one, so the session continues through exactly the
//  conditions that tripped it.
// ─────────────────────────────────────────────────────────────────────
{
  const ks = new KillSwitch({ config: testCfg(), logger: silentLog });
  assert("S3", "kill switch starts clear", ks.isHalted() === false);
  ks.triggerManual("test");
  assert("S3", "manual trigger halts", ks.isHalted() === true);
  for (let i = 0; i < 50; i++) ks.recordApiSuccess();
  assert("S3", "fifty successes do not clear a halt", ks.isHalted() === true);
  const why = ks.getReason();
  assert("S3", "the reason survives, with its trigger and timestamp",
    why?.trigger === "manual_api" && why?.detail === "test" && Number.isFinite(why?.at),
    JSON.stringify(why));
}

// ─────────────────────────────────────────────────────────────────────
//  S9 — the same signal five times is one order
// ─────────────────────────────────────────────────────────────────────
{
  const client = spyClient();
  const eng = engineWith({ client });
  const order = goodOrder();
  const outs = [];
  for (let i = 0; i < 5; i++) outs.push(await eng.placeOrder({ ...order }));

  assert("S9", "five identical signals submit exactly one order",
    client.calls.placeOrder.length === 1,
    `placeOrder calls=${client.calls.placeOrder.length}`);
  assert("S9", "the first attempt is the one that succeeds", outs[0].success === true,
    JSON.stringify(outs[0]));
  assert("S9", "the rest are reported as duplicates",
    outs.slice(1).every(o => o.success === false && String(o.reason).startsWith("duplicate")),
    JSON.stringify(outs.slice(1).map(o => o.reason)));
}

// ─────────────────────────────────────────────────────────────────────
//  S11 — an API failure is survivable
// ─────────────────────────────────────────────────────────────────────
{
  const boom = Object.assign(new Error("exchange exploded"), { status: 500 });
  const client = spyClient({ throwOnPlace: boom });
  const risk = new LiveRiskEngine(testCfg(), silentLog);
  const eng = engineWith({ client, risk });

  let unhandled = null;
  const onRej = e => { unhandled = e; };
  process.on("unhandledRejection", onRej);

  let out = null, threw = null;
  try { out = await eng.placeOrder(goodOrder()); } catch (e) { threw = e; }
  await new Promise(r => setImmediate(r));
  process.off("unhandledRejection", onRej);

  assert("S11", "an API failure does not throw out of placeOrder", threw === null,
    threw?.message);
  assert("S11", "an API failure is reported, not swallowed",
    out?.success === false && String(out?.reason).startsWith("api_error"),
    JSON.stringify(out));
  assert("S11", "an API failure produces no unhandled rejection", unhandled === null,
    String(unhandled));
  assert("S11", "the rejection is counted towards the daily limit",
    risk.snapshot().rejectsToday > 0 || risk.isHalted(),
    JSON.stringify(risk.snapshot()));
}

// ─────────────────────────────────────────────────────────────────────
//  S12 — paper mode never builds a CLOB client
//
//  Paper mode is only a safe place to stand if it cannot reach the
//  exchange even by accident. Asserting on the returned response would
//  not catch a client that was constructed and then unused.
// ─────────────────────────────────────────────────────────────────────
{
  const paperCfg = structuredClone(LIVE_CONFIG);
  paperCfg.mode = "paper";
  const client = new PolymarketClient(paperCfg, silentLog);
  let clobRequests = 0;
  const original = client._getClobClient.bind(client);
  client._getClobClient = async (...a) => { clobRequests++; return original(...a); };

  const resp = await client.placeOrder({ tokenId: "tok", side: "BUY", price: 0.5, size: 10 });
  assert("S12", "paper mode returns a simulated fill", resp.paper === true && resp.success === true,
    JSON.stringify(resp));
  assert("S12", "paper mode never asks for a CLOB client", clobRequests === 0,
    `requests=${clobRequests}`);
}

// ─────────────────────────────────────────────────────────────────────
//  S13 — live mode requires an explicit opt-in
//
//  Setting TRADING_MODE=live must not be enough on its own. Someone
//  copying a command from a runbook should not be able to start trading
//  real money with one word.
// ─────────────────────────────────────────────────────────────────────
{
  const liveNoOptIn = structuredClone(LIVE_CONFIG);
  liveNoOptIn.mode = "live";
  liveNoOptIn.enableLiveTrading = false;
  const pf = runLivePreflight(liveNoOptIn);
  assert("S13", "live without ENABLE_LIVE_TRADING fails preflight", pf.ok === false,
    JSON.stringify(pf.errors?.slice(0, 2)));
  assert("S13", "preflight names the missing opt-in",
    (pf.errors || []).some(e => e.includes("ENABLE_LIVE_TRADING")),
    JSON.stringify(pf.errors));

  const paper = structuredClone(LIVE_CONFIG);
  paper.mode = "paper";
  assert("S13", "paper mode passes preflight without any opt-in",
    runLivePreflight(paper).ok === true);
}

// ─────────────────────────────────────────────────────────────────────
//  S14 — defaults are safe with an empty environment
//
//  The question is what happens to someone who clones the repo and runs
//  it with no configuration at all. Every default that decides whether
//  money can move must fail closed.
// ─────────────────────────────────────────────────────────────────────
{
  assert("S14", "default mode is paper", LIVE_CONFIG.mode === "paper",
    String(LIVE_CONFIG.mode));
  assert("S14", "live trading is off by default", LIVE_CONFIG.enableLiveTrading !== true,
    String(LIVE_CONFIG.enableLiveTrading));
  assert("S14", "no private key is baked in", !LIVE_CONFIG.clob.privateKey);
  assert("S14", "risk limits exist and are finite",
    [LIVE_CONFIG.risk.maxOrderQty, LIVE_CONFIG.risk.maxOrderNotional,
     LIVE_CONFIG.risk.maxPositionPerMarket, LIVE_CONFIG.risk.maxDailyLoss]
      .every(v => Number.isFinite(v) && v > 0),
    JSON.stringify(LIVE_CONFIG.risk));
}

// ─────────────────────────────────────────────────────────────────────
//  S15 — the private key never reaches a log line
//
//  Logs get pasted into issues, shipped to aggregators and read over
//  shoulders. A key that appears once is compromised permanently, so
//  this scans real captured output rather than trusting the sanitiser.
// ─────────────────────────────────────────────────────────────────────
{
  const SECRET = "0x" + "ab".repeat(32);
  const cfg = structuredClone(LIVE_CONFIG);
  cfg.mode = "paper";
  cfg.clob.privateKey = SECRET;

  const captured = [];
  const realLog = console.log, realErr = console.error, realWarn = console.warn;
  console.log = (...a) => captured.push(a.map(String).join(" "));
  console.error = (...a) => captured.push(a.map(String).join(" "));
  console.warn = (...a) => captured.push(a.map(String).join(" "));
  try {
    const c = new PolymarketClient(cfg);            // real logger, not silent
    await c.placeOrder({ tokenId: "tok", side: "BUY", price: 0.5, size: 10 });
    await c.cancelOrder("someOrder");
    const liveCfg = structuredClone(cfg);
    liveCfg.mode = "live";
    liveCfg.enableLiveTrading = false;
    runLivePreflight(liveCfg);
  } finally {
    console.log = realLog; console.error = realErr; console.warn = realWarn;
  }

  const blob = captured.join("\n");
  assert("S15", "something was actually logged, so the scan means something",
    captured.length > 0, `lines=${captured.length}`);
  assert("S15", "the private key appears in no log line",
    !blob.includes(SECRET), `found in ${captured.filter(l => l.includes(SECRET)).length} line(s)`);
  assert("S15", "not even a long prefix of it leaks",
    !blob.includes(SECRET.slice(0, 34)));
}

// ─────────────────────────────────────────────────────────────────────
//  S18 — slippage beyond tolerance is refused
// ─────────────────────────────────────────────────────────────────────
{
  const r = riskEngine({ risk: { maxSlippageBps: 50 } });
  const within = r.checkOrder({ size: 10, price: 0.5, side: "BUY", expectedPrice: 0.4990 });
  assert("S18", "a fill inside tolerance is allowed", within.ok === true, JSON.stringify(within));

  const beyond = r.checkOrder({ size: 10, price: 0.55, side: "BUY", expectedPrice: 0.50 });
  assert("S18", "a fill beyond tolerance is refused", beyond.ok === false, JSON.stringify(beyond));
  assert("S18", "the refusal says it was slippage",
    String(beyond.reason).includes("slippage"), String(beyond.reason));
}

// ─────────────────────────────────────────────────────────────────────
//  S19 — the price band guard is active
//
//  Restated here because this guard has been missing twice: once when it
//  did not exist, and once when smartMoneySigs shipped without it and
//  bought a token at 0.9840 that went to zero.
// ─────────────────────────────────────────────────────────────────────
{
  assert("S19", "the band is 0.20 to 0.80",
    DEFAULT_PRICE_BAND.min === 0.20 && DEFAULT_PRICE_BAND.max === 0.80,
    JSON.stringify(DEFAULT_PRICE_BAND));
  for (const p of [0.01, 0.05, 0.1999, 0.8001, 0.95, 0.9840, 0.999]) {
    assert("S19", `an extreme price is untradable (${p})`, isTradablePrice(p) === false);
  }
  for (const p of [0.20, 0.5, 0.80]) {
    assert("S19", `a mid-band price is tradable (${p})`, isTradablePrice(p) === true);
  }
  for (const bad of [NaN, undefined, null, "0.5", Infinity]) {
    assert("S19", `a malformed price is untradable (${String(bad)})`,
      isTradablePrice(bad) === false);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  S20 — reconciliation lets the exchange win
//
//  Local state is a belief; the exchange is the fact. A phantom position
//  that survives a sync is a position the engine will keep trading
//  against and never close.
// ─────────────────────────────────────────────────────────────────────
{
  const cfg = testCfg();
  cfg.mode = "live";                       // paper short-circuits the sync
  const truth = { tok1: 42, tok2: 0 };
  const wallet = {
    ...walletStub,
    async getPositionBalance(tid) { return truth[tid] ?? 0; },
  };
  const eng = new LiveExecutionEngine({
    cfg, logger: silentLog, client: spyClient(), wallet,
  });

  // A belief the exchange does not share, in both directions.
  eng.positions.restorePositions([
    { tokenId: "tok1", qty: 5,   avgEntryPrice: 0.5 },
    { tokenId: "tok2", qty: 999, avgEntryPrice: 0.5 },   // phantom
  ]);

  const after = await eng.syncPositions(["tok1", "tok2"]);
  assert("S20", "an understated position is corrected upward",
    after.tok1?.qty === 42, `tok1=${after.tok1?.qty}`);
  assert("S20", "a phantom position does not survive",
    (after.tok2?.qty ?? 0) === 0, `tok2=${after.tok2?.qty}`);
  assert("S20", "a second sync changes nothing",
    (await eng.syncPositions(["tok1", "tok2"])).tok1?.qty === 42);
}

const passed = results.filter(x => x.pass).length;
console.log("");
console.log("═══════════════════════════════════════════════════");
const ids = [...new Set(results.map(r => r.id))].sort();
console.log(`  Safety gates: ${passed}/${results.length} passed`);
console.log(`  covering ${ids.length} invariants: ${ids.join(" ")}`);
console.log("═══════════════════════════════════════════════════");
if (passed !== results.length) process.exit(1);
