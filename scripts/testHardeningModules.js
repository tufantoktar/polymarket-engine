// ═══════════════════════════════════════════════════════════════════════
//  scripts/testHardeningModules.js — V5.6 Phase 2 reliability tests
// ═══════════════════════════════════════════════════════════════════════
//  Coverage (per brief):
//    - snapshot save + load roundtrip
//    - startup when snapshot file is missing → null, no throw
//    - startup when snapshot file is corrupt → null, no throw
//    - observability flag updates (tradingBlocked, lastTrade, counters)
//    - alert trigger for each of the 4 rules
//    - alert de-dup (cooldown) + state-change re-trigger
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  buildSnapshot,
  writeSnapshotFile,
  loadSnapshotFileSync,
  applySnapshot,
  SnapshotWriter,
} from "../src/live/state/snapshot.js";
import { Observability } from "../src/live/monitoring/observability.js";
import { AlertEngine, ALERT_KEYS } from "../src/live/monitoring/alerts.js";
import { OrderStore } from "../src/live/state/orderStore.js";
import { PositionStore } from "../src/live/state/positionStore.js";
import { SignalDeduper } from "../src/live/state/signalDeduper.js";
import { ORDER_STATES } from "../src/live/state/orderStateMachine.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  if (!cond) console.error(`  FAIL ${name}${detail ? ": " + detail : ""}`);
};

const silentLog = {
  info: () => {}, warn: () => {}, debug: () => {}, error: () => {},
  decision: () => {}, trade: () => {}, errorEvent: () => {},
};

// ───────────────────────────────────────────────────────────────────────
// SECTION 1 — snapshot save/load roundtrip
// ───────────────────────────────────────────────────────────────────────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-snap-"));
  const filePath = path.join(tmpDir, "snap.json");

  const orderStore = new OrderStore();
  const positionStore = new PositionStore();
  const signalDeduper = new SignalDeduper();

  // Put some state in place
  positionStore.applyFill({ tokenId: "tokX", side: "BUY", size: 50, price: 0.40 });
  const { order } = orderStore.create({ signalKey: "s1", tokenId: "tokY", side: "BUY", size: 25, price: 0.5 });
  orderStore.transition(order.orderId, ORDER_STATES.SIGNAL_DETECTED);
  orderStore.transition(order.orderId, ORDER_STATES.ORDER_PLACED, { externalOrderId: "EXT_1" });

  const snap = buildSnapshot({ orderStore, positionStore });
  assert("snap:schemaVersion present", typeof snap.schemaVersion === "number");
  assert("snap:has savedAt", typeof snap.savedAt === "number");
  assert("snap:positions len=1", snap.positions.length === 1);
  assert("snap:open order len=1", snap.orders.open.length === 1);
  assert("snap:open order has externalOrderId", snap.orders.open[0].externalOrderId === "EXT_1");

  // Atomic write
  const res = await writeSnapshotFile(filePath, snap, silentLog);
  assert("snap:write ok", res.ok);
  assert("snap:file exists", fs.existsSync(filePath));
  assert("snap:tmp file cleaned up", !fs.existsSync(filePath + ".tmp"));

  // Reload
  const loaded = loadSnapshotFileSync(filePath, silentLog);
  assert("snap:load returns object", loaded !== null && typeof loaded === "object");
  assert("snap:loaded schemaVersion matches", loaded.schemaVersion === snap.schemaVersion);
  assert("snap:loaded positions match", loaded.positions.length === 1 && loaded.positions[0].tokenId === "tokX");
  assert("snap:loaded orders match", loaded.orders.open[0].orderId === order.orderId);

  // Apply into fresh stores
  const os2 = new OrderStore();
  const ps2 = new PositionStore();
  const dd2 = new SignalDeduper();
  const applyRes = applySnapshot(loaded, { orderStore: os2, positionStore: ps2, signalDeduper: dd2, logger: silentLog });
  assert("snap:apply restored positions", applyRes.positionsRestored === 1);
  assert("snap:apply restored orders", applyRes.ordersRestored === 1);
  assert("snap:position qty preserved", ps2.get("tokX").qty === 50);
  assert("snap:order findable by internal id", os2.get(order.orderId) !== null);
  assert("snap:order findable by external id", os2.findByExternalOrderId("EXT_1") !== null);
  assert("snap:order state preserved", os2.get(order.orderId).state === ORDER_STATES.ORDER_PLACED);
  // SignalDeduper should have been primed so a fresh signal won't duplicate
  assert("snap:deduper primed", dd2.has("s1"));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ───────────────────────────────────────────────────────────────────────
// SECTION 2 — startup when snapshot file is missing
// ───────────────────────────────────────────────────────────────────────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-snap-"));
  const missing = path.join(tmpDir, "nope.json");
  const r = loadSnapshotFileSync(missing, silentLog);
  assert("snap:missing file returns null", r === null);

  // Applying null should not throw
  const out = applySnapshot(null, { orderStore: new OrderStore(), positionStore: new PositionStore(), signalDeduper: new SignalDeduper(), logger: silentLog });
  assert("snap:apply(null) no throw", out.ordersRestored === 0 && out.positionsRestored === 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ───────────────────────────────────────────────────────────────────────
// SECTION 3 — startup when snapshot file is corrupt
// ───────────────────────────────────────────────────────────────────────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-snap-"));
  const filePath = path.join(tmpDir, "corrupt.json");

  // Case A: invalid JSON
  fs.writeFileSync(filePath, "{not_json!");
  const a = loadSnapshotFileSync(filePath, silentLog);
  assert("snap:corrupt JSON returns null", a === null);

  // Case B: empty file
  fs.writeFileSync(filePath, "");
  const b = loadSnapshotFileSync(filePath, silentLog);
  assert("snap:empty file returns null", b === null);

  // Case C: wrong schema version
  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 999, savedAt: 1 }));
  const c = loadSnapshotFileSync(filePath, silentLog);
  assert("snap:wrong schemaVersion returns null", c === null);

  // Case D: totally unexpected shape
  fs.writeFileSync(filePath, JSON.stringify([1, 2, 3]));
  const d = loadSnapshotFileSync(filePath, silentLog);
  assert("snap:unexpected shape returns null", d === null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ───────────────────────────────────────────────────────────────────────
// SECTION 4 — snapshot write failure doesn't throw
// ───────────────────────────────────────────────────────────────────────
{
  // Force a write failure by pointing at a path where the parent is a
  // file (not a dir) — any fs op under it will fail.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-snap-"));
  const blocker = path.join(tmpDir, "blocker");
  fs.writeFileSync(blocker, "x");
  const badPath = path.join(blocker, "subdir", "snap.json");

  const res = await writeSnapshotFile(badPath, { foo: 1 }, silentLog);
  assert("snap:write failure returns {ok:false}", res.ok === false);
  assert("snap:write failure has error", typeof res.error === "string");
  // Critically, no throw

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ───────────────────────────────────────────────────────────────────────
// SECTION 5 — Observability flag updates
// ───────────────────────────────────────────────────────────────────────
{
  const obs = new Observability();
  const s0 = obs.snapshot();
  assert("obs:initial tradingBlocked false", s0.tradingBlocked === false);
  assert("obs:initial tradingBlockedReason null", s0.tradingBlockedReason === null);
  assert("obs:initial lastTradeTimestamp null", s0.lastTradeTimestamp === null);
  assert("obs:initial noTradeDuration null", s0.noTradeDuration === null);
  assert("obs:initial repeatedDuplicateSignals 0", s0.repeatedDuplicateSignals === 0);
  assert("obs:initial reconcileMismatchCount 0", s0.reconcileMismatchCount === 0);

  // setTradingBlocked
  obs.setTradingBlocked("halted_by_test");
  const s1 = obs.snapshot();
  assert("obs:after setBlocked true", s1.tradingBlocked === true);
  assert("obs:reason set", s1.tradingBlockedReason === "halted_by_test");
  assert("obs:tradingBlockedSince populated", typeof s1.tradingBlockedSince === "number");
  const sinceSnapshot1 = s1.tradingBlockedSince;

  // Re-calling with same reason is a no-op (timestamp stays)
  obs.setTradingBlocked("halted_by_test");
  assert("obs:same reason does not reset timestamp", obs.snapshot().tradingBlockedSince === sinceSnapshot1);

  // Reason change updates the reason but keeps timestamp
  obs.setTradingBlocked("halted_for_other_reason");
  const s2 = obs.snapshot();
  assert("obs:reason change updated", s2.tradingBlockedReason === "halted_for_other_reason");
  assert("obs:reason change keeps since", s2.tradingBlockedSince === sinceSnapshot1);

  // Clear
  obs.clearTradingBlocked();
  const s3 = obs.snapshot();
  assert("obs:clear sets false", s3.tradingBlocked === false);
  assert("obs:clear resets reason", s3.tradingBlockedReason === null);
  assert("obs:clear resets since", s3.tradingBlockedSince === null);

  // recordFill
  obs.recordFill();
  const s4 = obs.snapshot();
  assert("obs:recordFill sets lastTradeTimestamp", typeof s4.lastTradeTimestamp === "number");
  assert("obs:noTradeDuration becomes finite", typeof s4.noTradeDuration === "number" && s4.noTradeDuration >= 0);

  // recordDuplicateSignal
  obs.recordDuplicateSignal(); obs.recordDuplicateSignal(); obs.recordDuplicateSignal();
  const s5 = obs.snapshot();
  assert("obs:dup counter increments", s5.repeatedDuplicateSignals === 3);
  assert("obs:lastDuplicateAt populated", typeof s5.lastDuplicateAt === "number");

  // recordReconciliation with mismatches
  obs.recordReconciliation({ mismatches: [{}, {}] });
  obs.recordReconciliation({ mismatches: [] });  // no mismatches doesn't inc
  obs.recordReconciliation({ mismatches: [{}] });
  const s6 = obs.snapshot();
  assert("obs:reconcile counter sums mismatches", s6.reconcileMismatchCount === 3);
  assert("obs:lastReconcileAt populated", typeof s6.lastReconcileAt === "number");

  // resetCounters for tests/operator
  obs.resetCounters();
  const s7 = obs.snapshot();
  assert("obs:reset clears dup counter", s7.repeatedDuplicateSignals === 0);
  assert("obs:reset clears recon counter", s7.reconcileMismatchCount === 0);

  // Defensive: bad inputs do nothing bad
  obs.setTradingBlocked(null);   // should be no-op
  obs.setTradingBlocked("");      // empty string — also no-op
  obs.recordReconciliation(null); // no-op
  obs.recordReconciliation({});   // no mismatches key → 0 added
  const s8 = obs.snapshot();
  assert("obs:defensive inputs no-op", s8.tradingBlocked === false && s8.reconcileMismatchCount === 0);
}

// ───────────────────────────────────────────────────────────────────────
// SECTION 6 — Alert triggering + cooldown + state-change re-trigger
// ───────────────────────────────────────────────────────────────────────
{
  // Capture warn() calls to verify de-dup
  const warnCalls = [];
  const infoCalls = [];
  const logger = {
    ...silentLog,
    warn: (msg, payload) => warnCalls.push({ msg, payload }),
    info: (msg, payload) => infoCalls.push({ msg, payload }),
  };

  let now = 1_000_000_000_000;
  const cfg = {
    alerts: {
      noTradeAlertMs: 10_000,
      recoveryPendingGraceMs: 5_000,
      duplicateSignalThreshold: 10,
      reconcileMismatchThreshold: 3,
      cooldownMs: 60_000,
    },
  };
  const alerts = new AlertEngine({ logger, config: cfg, now: () => now });

  // No conditions triggered
  let active = alerts.evaluate({
    observability: { noTradeDuration: 5000, repeatedDuplicateSignals: 0, reconcileMismatchCount: 0 },
    recovery: { status: "ok" },
    bootAt: now - 60000,
  });
  assert("alerts:clean → none active", active.length === 0);
  assert("alerts:no warn emitted", warnCalls.length === 0);

  // 1) NO_TRADES trigger
  warnCalls.length = 0;
  alerts.evaluate({
    observability: { noTradeDuration: 15000, repeatedDuplicateSignals: 0, reconcileMismatchCount: 0 },
    recovery: { status: "ok" },
    bootAt: now - 60000,
  });
  assert("alerts:no_trades fires", warnCalls.some(c => c.msg === `alert:${ALERT_KEYS.NO_TRADES}`));
  assert("alerts:no_trades active", alerts.listActive().some(a => a.key === ALERT_KEYS.NO_TRADES));

  // Call again within cooldown — no second warn for same alert
  warnCalls.length = 0;
  now += 1000;
  alerts.evaluate({
    observability: { noTradeDuration: 16000, repeatedDuplicateSignals: 0, reconcileMismatchCount: 0 },
    recovery: { status: "ok" },
    bootAt: now - 60000,
  });
  assert("alerts:cooldown suppresses re-log", warnCalls.filter(c => c.msg === `alert:${ALERT_KEYS.NO_TRADES}`).length === 0);

  // Advance past cooldown — should re-log
  warnCalls.length = 0;
  now += cfg.alerts.cooldownMs + 1000;
  alerts.evaluate({
    observability: { noTradeDuration: 30000, repeatedDuplicateSignals: 0, reconcileMismatchCount: 0 },
    recovery: { status: "ok" },
    bootAt: now - 120000,
  });
  assert("alerts:re-log after cooldown", warnCalls.some(c => c.msg === `alert:${ALERT_KEYS.NO_TRADES}`));

  // Condition clears → cleared log via .info (cleared handler)
  infoCalls.length = 0;
  warnCalls.length = 0;
  now += 1000;
  alerts.evaluate({
    observability: { noTradeDuration: 1000, repeatedDuplicateSignals: 0, reconcileMismatchCount: 0 },
    recovery: { status: "ok" },
    bootAt: now - 120000,
  });
  assert("alerts:clear emits info", infoCalls.some(c => c.msg === `alert:${ALERT_KEYS.NO_TRADES}:cleared`));
  assert("alerts:cleared removes from active", !alerts.listActive().some(a => a.key === ALERT_KEYS.NO_TRADES));

  // Re-trigger after clear → state change, logs immediately regardless of cooldown
  warnCalls.length = 0;
  now += 100;   // well within cooldown
  alerts.evaluate({
    observability: { noTradeDuration: 30000, repeatedDuplicateSignals: 0, reconcileMismatchCount: 0 },
    recovery: { status: "ok" },
    bootAt: now - 200000,
  });
  assert("alerts:state-change re-fires inside cooldown",
    warnCalls.some(c => c.msg === `alert:${ALERT_KEYS.NO_TRADES}` && c.payload?.stateChange === true));

  // 2) RECOVERY_PENDING trigger
  warnCalls.length = 0;
  const alerts2 = new AlertEngine({ logger, config: cfg, now: () => now });
  alerts2.evaluate({
    observability: { repeatedDuplicateSignals: 0, reconcileMismatchCount: 0 },
    recovery: { status: "running" },
    bootAt: now - cfg.alerts.recoveryPendingGraceMs - 1000,
  });
  assert("alerts:recovery_pending fires", warnCalls.some(c => c.msg === `alert:${ALERT_KEYS.RECOVERY_PENDING}`));
  // recovery ok → clear
  alerts2.evaluate({
    observability: { repeatedDuplicateSignals: 0, reconcileMismatchCount: 0 },
    recovery: { status: "ok" },
    bootAt: now - cfg.alerts.recoveryPendingGraceMs - 1000,
  });
  assert("alerts:recovery ok clears", !alerts2.listActive().some(a => a.key === ALERT_KEYS.RECOVERY_PENDING));
  // skipped status is also considered OK (no alert)
  const alerts2b = new AlertEngine({ logger, config: cfg, now: () => now });
  alerts2b.evaluate({
    observability: { repeatedDuplicateSignals: 0, reconcileMismatchCount: 0 },
    recovery: { status: "skipped" },
    bootAt: now - cfg.alerts.recoveryPendingGraceMs - 1000,
  });
  assert("alerts:recovery skipped treated as ok", !alerts2b.listActive().some(a => a.key === ALERT_KEYS.RECOVERY_PENDING));

  // 3) DUPLICATE_SPAM trigger
  warnCalls.length = 0;
  const alerts3 = new AlertEngine({ logger, config: cfg, now: () => now });
  alerts3.evaluate({
    observability: { noTradeDuration: 0, repeatedDuplicateSignals: 20, reconcileMismatchCount: 0 },
    recovery: { status: "ok" },
    bootAt: now - 60000,
  });
  assert("alerts:duplicate_spam fires", warnCalls.some(c => c.msg === `alert:${ALERT_KEYS.DUPLICATE_SPAM}`));

  // 4) RECONCILE_DRIFT trigger
  warnCalls.length = 0;
  const alerts4 = new AlertEngine({ logger, config: cfg, now: () => now });
  alerts4.evaluate({
    observability: { noTradeDuration: 0, repeatedDuplicateSignals: 0, reconcileMismatchCount: 5 },
    recovery: { status: "ok" },
    bootAt: now - 60000,
  });
  assert("alerts:reconcile_drift fires", warnCalls.some(c => c.msg === `alert:${ALERT_KEYS.RECONCILE_DRIFT}`));

  // Snapshot shape
  const snap = alerts4.snapshot();
  assert("alerts:snapshot has thresholds", typeof snap.thresholds === "object");
  assert("alerts:snapshot has all 4 keys", Object.keys(snap.alerts).length === 4);
}

// ───────────────────────────────────────────────────────────────────────
// SECTION 7 — SnapshotWriter interval write + flush
// ───────────────────────────────────────────────────────────────────────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-snap-"));
  const filePath = path.join(tmpDir, "rt.json");
  const orderStore = new OrderStore();
  const positionStore = new PositionStore();
  positionStore.applyFill({ tokenId: "w", side: "BUY", size: 10, price: 0.3 });

  const writer = new SnapshotWriter({
    filePath,
    intervalMs: 50_000,        // won't fire during the test
    sources: { orderStore, positionStore },
    logger: silentLog,
  });
  writer.start();
  // Manual flush should write immediately
  const r = await writer.flush();
  assert("snap:writer flush ok", r.ok);
  assert("snap:file written on flush", fs.existsSync(filePath));
  const loaded = loadSnapshotFileSync(filePath, silentLog);
  assert("snap:written content loads", loaded !== null && loaded.positions.length === 1);

  // Stats populated
  const stats = writer.snapshot();
  assert("snap:writer stats.writes≥1", stats.writes >= 1);
  assert("snap:writer stats.lastWriteAt set", typeof stats.lastWriteAt === "number");

  writer.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ─── Summary ────────────────────────────────────────────────────────────
const pass = results.filter(r => r.pass).length;
const fail = results.filter(r => !r.pass);
console.log(`\n═══════════════════════════════════════════════════`);
console.log(`  Hardening module tests: ${results.length} total, ${pass} passed, ${fail.length} failed`);
console.log(`═══════════════════════════════════════════════════`);
process.exit(fail.length > 0 ? 1 : 0);
