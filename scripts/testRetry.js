#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/testRetry.js — the retry layer had no tests at all
// ═══════════════════════════════════════════════════════════════════════
//  retry.js is the file the design review called the most dangerous in
//  the repo: submit() runs inside withRetry, the SDK generates a fresh
//  salt per call, and there is no client-side idempotency key, so a
//  retried order can become a second real order. It had never been
//  tested. These assertions do not fix that hazard - they pin the
//  current behaviour so the fix, when it comes, is visibly a change.
// ═══════════════════════════════════════════════════════════════════════
import { isRetryable, withRetry } from "../src/live/retry.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  if (!cond) console.log(`  FAIL ${name}${detail ? ": " + detail : ""}`);
};
const err = (status, code) => {
  const e = new Error(`synthetic ${status ?? code}`);
  if (status !== undefined) e.status = status;
  if (code !== undefined) e.code = code;
  return e;
};
const spyLog = () => {
  const calls = { errorEvent: [], debug: [] };
  return {
    calls,
    errorEvent: (src, e, ctx) => calls.errorEvent.push({ src, e, ctx }),
    debug: (msg, data) => calls.debug.push({ msg, data }),
    info: () => {}, warn: () => {},
  };
};
const opts = extra => ({ maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, ...extra });

// ─── Classification ─────────────────────────────────────────────────────
assert("429 is retryable", isRetryable(err(429)) === true);
assert("500 is retryable", isRetryable(err(500)) === true);
assert("503 is retryable", isRetryable(err(503)) === true);
assert("404 is not retryable", isRetryable(err(404)) === false);
assert("400 is not retryable", isRetryable(err(400)) === false);
assert("401 is not retryable", isRetryable(err(401)) === false);
assert("ECONNRESET is retryable", isRetryable(err(undefined, "ECONNRESET")) === true);
assert("ETIMEDOUT is retryable", isRetryable(err(undefined, "ETIMEDOUT")) === true);
assert("null is not retryable", isRetryable(null) === false);

// The S10 hazard in one line. An error carrying neither status nor code
// is assumed transient and retried. For a read that is harmless; for
// submit() it is how one order becomes two.
assert("an unclassifiable error is assumed transient — this is S10",
  isRetryable(new Error("who knows")) === true);

// ─── Non-retryable: fail fast, and quietly ──────────────────────────────
{
  const log = spyLog();
  let calls = 0;
  let threw = null;
  try {
    await withRetry(async () => { calls++; throw err(404); }, opts({ logger: log, label: "t" }));
  } catch (e) { threw = e; }

  assert("non-retryable is attempted exactly once", calls === 1, `calls=${calls}`);
  assert("non-retryable still throws", threw?.status === 404);
  assert("non-retryable is NOT logged as an error",
    log.calls.errorEvent.length === 0, `errorEvent=${log.calls.errorEvent.length}`);
  assert("non-retryable is visible at debug level",
    log.calls.debug.length === 1 && log.calls.debug[0].data.status === 404,
    JSON.stringify(log.calls.debug));
}

// ─── Retryable: still loud, still bounded ───────────────────────────────
{
  const log = spyLog();
  let calls = 0;
  let threw = null;
  try {
    await withRetry(async () => { calls++; throw err(503); }, opts({ logger: log, label: "t" }));
  } catch (e) { threw = e; }

  assert("retryable is attempted maxAttempts times", calls === 3, `calls=${calls}`);
  assert("retryable throws after exhausting attempts", threw?.status === 503);
  assert("every retryable attempt is logged as an error",
    log.calls.errorEvent.length === 3, `errorEvent=${log.calls.errorEvent.length}`);
  assert("the log records that it was retryable",
    log.calls.errorEvent.every(c => c.ctx.retryable === true));
}

// ─── Recovery ───────────────────────────────────────────────────────────
{
  const log = spyLog();
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    if (calls < 2) throw err(500);
    return "ok";
  }, opts({ logger: log, label: "t" }));

  assert("a transient failure recovers", out === "ok" && calls === 2, `calls=${calls}`);
  assert("only the failed attempt was logged", log.calls.errorEvent.length === 1);
}

// ─── Loggers that predate debug must not crash ──────────────────────────
//  src/backtest/runner.js injects a stub with only errorEvent. Calling
//  debug unconditionally would turn a quiet 404 into a crash.
{
  const bare = { errorEvent: () => {} };
  let threw = null, crashed = false;
  try {
    await withRetry(async () => { throw err(404); }, opts({ logger: bare, label: "t" }));
  } catch (e) { threw = e; if (!(e.status === 404)) crashed = true; }
  assert("a logger without debug does not crash the retry layer",
    threw?.status === 404 && !crashed, threw?.message);
}

const passed = results.filter(r => r.pass).length;
console.log("");
console.log("═══════════════════════════════════════════════════");
console.log(`  Retry tests: ${passed}/${results.length} passed`);
console.log("═══════════════════════════════════════════════════");
if (passed !== results.length) process.exit(1);
