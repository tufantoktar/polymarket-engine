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
      const out = r.checkOrder({ size, price });
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
  const out = r.checkOrder({ size: 10, price: 0.5 });
  assert("S8", "order beyond the concurrency cap is rejected",
    out.ok === false && String(out.reason).includes("concurrent"),
    JSON.stringify(out));
  r.untrackOrder("o0");
  assert("S8", "freeing a slot allows the next order",
    r.checkOrder({ size: 10, price: 0.5 }).ok === true);
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
    r.checkOrder({ size: 10, price: 0.5 }).ok === false);
  r.recordRealizedPnl(+1000);
  assert("S3", "a halt does not clear itself on later success",
    r.isHalted() === true);
}
{
  const r = riskEngine({ risk: { maxDailyRejects: 5 } });
  for (let i = 0; i < 5; i++) r.recordReject("test");
  assert("S17", "daily reject limit halts", r.isHalted() === true);
}

const passed = results.filter(x => x.pass).length;
console.log("");
console.log("═══════════════════════════════════════════════════");
console.log(`  Safety gates (bölüm 1): ${passed}/${results.length} passed`);
console.log("═══════════════════════════════════════════════════");
if (passed !== results.length) process.exit(1);
