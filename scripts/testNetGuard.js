#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/testNetGuard.js — the guard has to be seen firing
// ═══════════════════════════════════════════════════════════════════════
//  verify preloads netGuard.mjs into every suite so a test cannot reach
//  the network. A guard nobody has watched fire is indistinguishable
//  from one that does nothing: the collector watchdog logged successes
//  it never achieved for exactly that reason.
//
//  This imports the guard directly rather than relying on the preload,
//  so it means the same thing whether run through verify or on its own.
// ═══════════════════════════════════════════════════════════════════════
const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  if (!cond) console.log(`  FAIL ${name}${detail ? ": " + detail : ""}`);
};

// verify preloads the guard into every suite, so under verify fetch is
// already replaced before this line runs. Asserting that the import
// CHANGES fetch would then fail for the best possible reason - the guard
// was already doing its job. What matters is the end state, not who
// installed it.
await import("./netGuard.mjs");

// ─── fetch ──────────────────────────────────────────────────────────────
assert("fetch is not the platform implementation",
  globalThis.fetch?.name !== "fetch" || String(globalThis.fetch).includes("forbidden"),
  String(globalThis.fetch).slice(0, 60));
{
  let msg = null;
  try { await globalThis.fetch("https://clob.polymarket.com/book"); }
  catch (e) { msg = e.message; }
  assert("fetch to a real endpoint is refused", msg !== null);
  assert("the refusal explains itself", /network access is forbidden/.test(msg || ""), msg);
  assert("the refusal names the target", /clob\.polymarket\.com/.test(msg || ""), msg);
}

// ─── http / https ───────────────────────────────────────────────────────
for (const mod of ["node:http", "node:https"]) {
  const api = (await import(mod)).default;
  for (const fn of ["request", "get"]) {
    let threw = false;
    try { api[fn]("https://clob.polymarket.com/book"); } catch { threw = true; }
    assert(`${mod}.${fn} is refused`, threw);
  }
}

// ─── sockets ────────────────────────────────────────────────────────────
//  Loopback stays open on purpose: blocking it would break the tooling
//  that runs the tests rather than the tests themselves.
{
  const net = (await import("node:net")).default;
  let remoteThrew = false;
  try { new net.Socket().connect({ host: "clob.polymarket.com", port: 443 }); }
  catch { remoteThrew = true; }
  assert("a remote socket is refused", remoteThrew);

  let localThrew = false;
  const s = new net.Socket();
  s.on("error", () => {});
  try { s.connect({ host: "127.0.0.1", port: 1 }); } catch { localThrew = true; }
  s.destroy();
  assert("loopback is left alone", localThrew === false);
}

const passed = results.filter(r => r.pass).length;
console.log("");
console.log("═══════════════════════════════════════════════════");
console.log(`  Network guard tests: ${passed}/${results.length} passed`);
console.log("═══════════════════════════════════════════════════");
if (passed !== results.length) process.exit(1);
