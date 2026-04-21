// ═══════════════════════════════════════════════════════════════════════
//  scripts/testStateModules.js — unit tests for V5.4 state modules
// ═══════════════════════════════════════════════════════════════════════
//  No test framework — simple assert-based script.
//
//  Usage: node scripts/testStateModules.js
// ═══════════════════════════════════════════════════════════════════════

import {
  ORDER_STATES,
  createOrderState,
  canTransition,
  transitionOrder,
  isTerminalState,
} from "../src/live/state/orderStateMachine.js";
import { OrderStore } from "../src/live/state/orderStore.js";
import { PositionStore } from "../src/live/state/positionStore.js";
import { SignalDeduper, buildSignalKey } from "../src/live/state/signalDeduper.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
};

// ─── orderStateMachine ──────────────────────────────────────────────────
{
  // Valid/invalid transitions
  assert("fsm:IDLE->SIGNAL_DETECTED allowed", canTransition("IDLE", "SIGNAL_DETECTED"));
  assert("fsm:SIGNAL_DETECTED->ORDER_PLACED allowed", canTransition("SIGNAL_DETECTED", "ORDER_PLACED"));
  assert("fsm:ORDER_PLACED->FILLED allowed", canTransition("ORDER_PLACED", "FILLED"));
  assert("fsm:FILLED->any blocked", !canTransition("FILLED", "CANCELLED"));
  assert("fsm:CANCELLED->any blocked", !canTransition("CANCELLED", "FILLED"));
  assert("fsm:FAILED->any blocked", !canTransition("FAILED", "ORDER_PLACED"));
  assert("fsm:IDLE->ORDER_PLACED blocked (skipping SIGNAL_DETECTED)", !canTransition("IDLE", "ORDER_PLACED"));

  // isTerminalState
  assert("fsm:FILLED terminal", isTerminalState("FILLED"));
  assert("fsm:CANCELLED terminal", isTerminalState("CANCELLED"));
  assert("fsm:FAILED terminal", isTerminalState("FAILED"));
  assert("fsm:ORDER_PLACED not terminal", !isTerminalState("ORDER_PLACED"));

  // createOrderState requires valid input
  let threw = false;
  try { createOrderState({ orderId: "x", signalKey: "k", tokenId: "t", side: "BAD", size: 10 }); }
  catch { threw = true; }
  assert("fsm:createOrderState rejects invalid side", threw);

  // Happy path transitions
  const o0 = createOrderState({ orderId: "o1", signalKey: "sk1", tokenId: "t1", side: "BUY", size: 100, price: 0.5 });
  assert("fsm:initial state IDLE", o0.state === "IDLE");
  assert("fsm:history starts with IDLE", o0.history.length === 1 && o0.history[0].state === "IDLE");

  const t1 = transitionOrder(o0, "SIGNAL_DETECTED");
  assert("fsm:IDLE->SIGNAL_DETECTED ok", t1.ok && t1.order.state === "SIGNAL_DETECTED");
  assert("fsm:history appended", t1.order.history.length === 2);

  const t2 = transitionOrder(t1.order, "ORDER_PLACED", { externalOrderId: "ext1" });
  assert("fsm:ORDER_PLACED sets placedAt", t2.ok && t2.order.placedAt !== null);
  assert("fsm:patch applied", t2.order.externalOrderId === "ext1");

  const t3 = transitionOrder(t2.order, "FILLED", { filledSize: 100, avgFillPrice: 0.5 });
  assert("fsm:FILLED sets terminalAt", t3.ok && t3.order.terminalAt !== null);

  const t4 = transitionOrder(t3.order, "CANCELLED");
  assert("fsm:transition out of terminal rejected structurally", !t4.ok && /terminal/.test(t4.error));

  // Invalid transition returns structured failure (no throw)
  const oBad = createOrderState({ orderId: "o2", signalKey: "sk2", tokenId: "t2", side: "BUY", size: 10 });
  const tBad = transitionOrder(oBad, "FILLED");   // IDLE → FILLED not allowed
  assert("fsm:invalid transition returns {ok:false}", !tBad.ok && /invalid_transition/.test(tBad.error));
}

// ─── orderStore ─────────────────────────────────────────────────────────
{
  const store = new OrderStore();

  // Create
  const { duplicate: d1, order: o1 } = store.create({ signalKey: "sk-a", tokenId: "tok-a", side: "BUY", size: 10 });
  assert("store:first create not duplicate", !d1);
  assert("store:orderId assigned", typeof o1.orderId === "string" && o1.orderId.length > 0);

  // Duplicate detection
  const { duplicate: d2 } = store.create({ signalKey: "sk-a", tokenId: "tok-a", side: "BUY", size: 20 });
  assert("store:duplicate signalKey detected", d2);

  // Lookup
  assert("store:get by orderId", store.get(o1.orderId)?.orderId === o1.orderId);
  assert("store:getBySignalKey", store.getBySignalKey("sk-a")?.orderId === o1.orderId);
  assert("store:hasSignalKey active", store.hasSignalKey("sk-a"));

  // Transition via store
  const tr = store.transition(o1.orderId, "SIGNAL_DETECTED");
  assert("store:transition ok", tr.ok);
  assert("store:state persisted", store.get(o1.orderId).state === "SIGNAL_DETECTED");

  // External mapping
  store.transition(o1.orderId, "ORDER_PLACED", { externalOrderId: "EXT_001" });
  assert("store:findByExternalOrderId works", store.findByExternalOrderId("EXT_001")?.orderId === o1.orderId);

  // listOpenOrders excludes terminal
  const { order: o2 } = store.create({ signalKey: "sk-b", tokenId: "tok-b", side: "SELL", size: 5 });
  store.transition(o2.orderId, "SIGNAL_DETECTED");
  store.transition(o2.orderId, "FAILED", { reason: "test" });
  const open = store.listOpenOrders();
  assert("store:listOpenOrders excludes FAILED", open.every(o => o.state !== "FAILED"));
  assert("store:listOpenOrders includes ORDER_PLACED", open.some(o => o.orderId === o1.orderId));

  // After order is terminal, same signalKey should be createable again
  store.transition(o1.orderId, "FILLED", { filledSize: 10, avgFillPrice: 0.5 });
  const retry = store.create({ signalKey: "sk-a", tokenId: "tok-a", side: "BUY", size: 10 });
  assert("store:same signalKey allowed after terminal", !retry.duplicate);

  // snapshot
  const snap = store.snapshot();
  assert("store:snapshot shape", snap.total >= 3 && snap.byState.FILLED >= 1 && snap.byState.FAILED >= 1);
}

// ─── positionStore ──────────────────────────────────────────────────────
{
  const ps = new PositionStore();

  // Fresh token returns empty default
  const empty = ps.get("tokX");
  assert("pos:empty default qty=0", empty.qty === 0);
  assert("pos:empty default avg=0", empty.avgEntryPrice === 0);

  // Simple BUY fill
  ps.applyFill({ tokenId: "tokA", side: "BUY", size: 100, price: 0.40 });
  let p = ps.get("tokA");
  assert("pos:BUY 100@0.40 qty=100", p.qty === 100);
  assert("pos:BUY 100@0.40 avg=0.40", Math.abs(p.avgEntryPrice - 0.40) < 1e-9);

  // Second BUY updates weighted avg
  ps.applyFill({ tokenId: "tokA", side: "BUY", size: 100, price: 0.60 });
  p = ps.get("tokA");
  assert("pos:avg weighted correctly", Math.abs(p.avgEntryPrice - 0.50) < 1e-9);
  assert("pos:qty accumulated", p.qty === 200);

  // SELL realizes PnL
  ps.applyFill({ tokenId: "tokA", side: "SELL", size: 100, price: 0.70 });
  p = ps.get("tokA");
  assert("pos:SELL reduces qty", p.qty === 100);
  assert("pos:realizedPnl = 100*(0.70-0.50) = 20", Math.abs(p.realizedPnl - 20) < 1e-9);

  // SELL closing full position
  ps.applyFill({ tokenId: "tokA", side: "SELL", size: 100, price: 0.55 });
  p = ps.get("tokA");
  assert("pos:fully closed qty=0", p.qty === 0);
  assert("pos:avg reset on zero", p.avgEntryPrice === 0);
  assert("pos:cumulative realized PnL", Math.abs(p.realizedPnl - 25) < 1e-9);

  // Invalid inputs throw
  let threw = false;
  try { ps.applyFill({ tokenId: "x", side: "BAD", size: 1, price: 0.5 }); } catch { threw = true; }
  assert("pos:rejects invalid side", threw);

  // restorePositions wipes + sets
  ps.restorePositions([{ tokenId: "tokB", qty: 50, avgEntryPrice: 0.30, realizedPnl: 0 }]);
  assert("pos:restore replaces state", ps.list().length === 1 && ps.get("tokB").qty === 50);

  // snapshot shape
  const sn = ps.snapshot();
  assert("pos:snapshot count", sn.count === 1);
  assert("pos:snapshot exposure gross", sn.exposure.gross === 15);  // 50 * 0.30
}

// ─── signalDeduper ──────────────────────────────────────────────────────
{
  // Deterministic key
  const sig = { source: "mom", marketId: "m1", tokenId: "t1", side: "BUY", action: "immediate", timestamp: 1700000000000 };
  const k1 = buildSignalKey(sig);
  const k2 = buildSignalKey(sig);
  assert("dedup:key deterministic", k1 === k2);

  // Same bucket = same key
  const k3 = buildSignalKey({ ...sig, timestamp: 1700000001500 });  // +1.5s → same 30s bucket
  assert("dedup:same bucket same key", k1 === k3);

  // Different bucket = different key
  const k4 = buildSignalKey({ ...sig, timestamp: 1700000045000 });  // +45s → different bucket
  assert("dedup:different bucket different key", k1 !== k4);

  // Different side = different key
  const k5 = buildSignalKey({ ...sig, side: "SELL" });
  assert("dedup:different side different key", k1 !== k5);

  // SignalDeduper lifecycle
  const dd = new SignalDeduper({ ttlMs: 1000, bucketMs: 30000 });
  assert("dedup:fresh cache empty", !dd.has("key1"));
  dd.mark("key1", { orderId: "o1" });
  assert("dedup:after mark has=true", dd.has("key1"));
  assert("dedup:get returns metadata", dd.get("key1")?.metadata?.orderId === "o1");

  // LRU cap
  const ddSmall = new SignalDeduper({ ttlMs: 60000, maxEntries: 3 });
  ddSmall.mark("a"); ddSmall.mark("b"); ddSmall.mark("c"); ddSmall.mark("d");
  assert("dedup:LRU evicts oldest", !ddSmall.has("a") && ddSmall.has("b") && ddSmall.has("c") && ddSmall.has("d"));

  // TTL expiration
  const ddShort = new SignalDeduper({ ttlMs: 5 });
  ddShort.mark("x");
  // Wait synchronously via a small busy-loop; cheap test
  const t0 = Date.now(); while (Date.now() - t0 < 20) { /* noop */ }
  assert("dedup:TTL expired", !ddShort.has("x"));

  // clearExpired
  const dd2 = new SignalDeduper({ ttlMs: 5 });
  dd2.mark("y"); dd2.mark("z");
  const t2 = Date.now(); while (Date.now() - t2 < 15) { /* noop */ }
  const removed = dd2.clearExpired();
  assert("dedup:clearExpired returns count", removed === 2);
  assert("dedup:after clearExpired cache empty", dd2.snapshot().size === 0);
}

// ─── Integration-ish: order + position together ─────────────────────────
{
  const orders = new OrderStore();
  const positions = new PositionStore();
  const deduper = new SignalDeduper();

  // Signal 1: BUY
  const sigA = { source: "test", marketId: "mk1", tokenId: "tk1", side: "BUY", action: "default", timestamp: 1700000000000 };
  const keyA = buildSignalKey(sigA);
  assert("int:fresh signal not dupe", !deduper.has(keyA));

  const { order: oA } = orders.create({ signalKey: keyA, marketId: "mk1", tokenId: "tk1", side: "BUY", size: 50, price: 0.40 });
  deduper.mark(keyA, { orderId: oA.orderId });
  orders.transition(oA.orderId, "SIGNAL_DETECTED");
  orders.transition(oA.orderId, "ORDER_PLACED", { externalOrderId: "EX_A" });

  // Simulate fill
  positions.applyFill({ tokenId: "tk1", side: "BUY", size: 50, price: 0.40, orderId: oA.orderId });
  orders.transition(oA.orderId, "FILLED", { filledSize: 50, avgFillPrice: 0.40 });

  assert("int:position reflects fill", positions.get("tk1").qty === 50);
  assert("int:order terminal after fill", orders.get(oA.orderId).state === "FILLED");

  // Duplicate attempt within bucket
  assert("int:duplicate rejected", deduper.has(keyA));
}

// ─── Summary ────────────────────────────────────────────────────────────
const pass = results.filter(r => r.pass).length;
const fail = results.filter(r => !r.pass);
console.log(`\n═══════════════════════════════════════════════════`);
console.log(`  State module tests: ${results.length} total, ${pass} passed, ${fail.length} failed`);
console.log(`═══════════════════════════════════════════════════`);
if (fail.length > 0) {
  for (const f of fail) console.log(`  FAIL: ${f.name} ${f.detail ? "(" + f.detail + ")" : ""}`);
  process.exit(1);
} else {
  console.log(`  All tests pass.\n`);
}
