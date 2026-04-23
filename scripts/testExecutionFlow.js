// ═══════════════════════════════════════════════════════════════════════
//  scripts/testExecutionFlow.js — end-to-end paper-mode execution test
// ═══════════════════════════════════════════════════════════════════════
//  Exercises LiveExecutionEngine with the new V5.4 state modules.
//  No network: uses paper mode + a mock PolymarketClient that returns
//  synthetic orderbooks and accepts all orders.
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG } from "../src/live/config/index.js";
import { LiveExecutionEngine } from "../src/live/execution_engine/index.js";
import { getLogger } from "../src/live/logging/index.js";
import { ORDER_STATES } from "../src/live/state/orderStateMachine.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  if (!cond) console.error(`  FAIL ${name}: ${detail}`);
};

// ─── Mock collaborators ─────────────────────────────────────────────────
const mockBook = {
  tokenId: "tok-1",
  bids: [{ price: 0.49, size: 1000 }],
  asks: [{ price: 0.51, size: 1000 }],
  bestBid: 0.49, bestAsk: 0.51,
  midPrice: 0.50, spread: 0.02,
  bidDepth: 490, askDepth: 510,
};

class MockClient {
  async getOrderbook() { return mockBook; }
  async placeOrder(o) {
    return { success: true, orderID: "EXT_" + Date.now() + "_" + Math.floor(Math.random()*1000), status: "resting" };
  }
  async cancelOrder(id) { return { success: true, canceled: [id] }; }
  async cancelAllOrders() { return { success: true }; }
  async getOpenOrders() { return []; }
  async getOrderStatus(id) { return { orderID: id, status: "resting" }; }
}

class MockWallet {
  async snapshot() { return { address: "0xtest", usdc: 1000, approvals: { usdc: true, ctf: true }, paper: true }; }
}

const cfg = { ...LIVE_CONFIG, mode: "paper" };
const log = getLogger(cfg);

// ─── Test 1: placeOrder happy path ──────────────────────────────────────
{
  const exec = new LiveExecutionEngine({
    cfg, logger: log,
    client: new MockClient(),
    wallet: new MockWallet(),
  });

  const r = await exec.placeOrder({
    signalKey: "test:sk1",
    tokenId: "tok-1",
    marketId: "mkt-1",
    side: "BUY",
    price: 0.50,
    size: 25,
    source: "testsuite",
  });

  assert("e2e:placeOrder success", r.success);
  assert("e2e:orderId returned", typeof r.orderId === "string");
  assert("e2e:externalOrderId returned", typeof r.externalOrderId === "string" && r.externalOrderId.startsWith("EXT_"));
  assert("e2e:order state = ORDER_PLACED", exec.orders.get(r.orderId).state === ORDER_STATES.ORDER_PLACED);
  assert("e2e:signalKey in deduper", exec.deduper.has("test:sk1"));
  assert("e2e:no position yet (no fill)", exec.positions.get("tok-1").qty === 0);

  // Simulate a fill
  const fr = exec.applyFill({ orderId: r.orderId, fillSize: 25, fillPrice: 0.50 });
  assert("e2e:applyFill ok", fr.ok);
  assert("e2e:order state = FILLED after fill", exec.orders.get(r.orderId).state === ORDER_STATES.FILLED);
  assert("e2e:position updated from fill", exec.positions.get("tok-1").qty === 25);
  assert("e2e:avgEntryPrice correct", Math.abs(exec.positions.get("tok-1").avgEntryPrice - 0.50) < 1e-9);
}

// ─── Test 2: partial fill then complete ─────────────────────────────────
{
  const exec = new LiveExecutionEngine({
    cfg, logger: log,
    client: new MockClient(),
    wallet: new MockWallet(),
  });

  const r = await exec.placeOrder({
    signalKey: "test:sk2",
    tokenId: "tok-2",
    side: "BUY", price: 0.50, size: 100,
  });
  assert("partial:placeOrder ok", r.success);

  exec.applyFill({ orderId: r.orderId, fillSize: 30, fillPrice: 0.50 });
  assert("partial:state=PARTIAL_FILL", exec.orders.get(r.orderId).state === ORDER_STATES.PARTIAL_FILL);
  assert("partial:filledSize=30", exec.orders.get(r.orderId).filledSize === 30);
  assert("partial:position qty=30", exec.positions.get("tok-2").qty === 30);

  exec.applyFill({ orderId: r.orderId, fillSize: 70, fillPrice: 0.52 });
  assert("partial:state=FILLED after remainder", exec.orders.get(r.orderId).state === ORDER_STATES.FILLED);
  assert("partial:final filledSize=100", exec.orders.get(r.orderId).filledSize === 100);
  assert("partial:final qty=100", exec.positions.get("tok-2").qty === 100);
  // Weighted avg: (30*0.50 + 70*0.52) / 100 = 0.514
  const avg = exec.orders.get(r.orderId).avgFillPrice;
  assert("partial:weighted avg correct", Math.abs(avg - 0.514) < 1e-6, `got ${avg}`);
}

// ─── Test 3: duplicate signalKey rejected ───────────────────────────────
{
  const exec = new LiveExecutionEngine({
    cfg, logger: log,
    client: new MockClient(),
    wallet: new MockWallet(),
  });

  const r1 = await exec.placeOrder({ signalKey: "dupe:1", tokenId: "tok-3", side: "BUY", price: 0.5, size: 10 });
  assert("dup:first ok", r1.success);

  const r2 = await exec.placeOrder({ signalKey: "dupe:1", tokenId: "tok-3", side: "BUY", price: 0.5, size: 10 });
  assert("dup:second rejected", !r2.success);
  assert("dup:reason is duplicate", /duplicate/.test(r2.reason || ""));
}

// ─── Test 4: risk rejection → FAILED FSM, no order created ──────────────
{
  const exec = new LiveExecutionEngine({
    cfg, logger: log,
    client: new MockClient(),
    wallet: new MockWallet(),
  });

  // Order exceeding maxOrderNotional → risk clamps size down
  const r = await exec.placeOrder({
    signalKey: "risk:1",
    tokenId: "tok-4",
    side: "BUY",
    price: 0.50,
    size: 10000,   // $5000 notional; maxOrderNotional is $100
  });
  assert("risk:order succeeds with adjusted size", r.success);
  const ord = exec.orders.get(r.orderId);
  assert("risk:size clamped to <= maxOrderQty", ord.size <= cfg.risk.maxOrderQty);
  const notional = ord.size * 0.50;
  assert("risk:notional within cap", notional <= cfg.risk.maxOrderNotional + 1e-6, `notional=${notional}`);
}

// ─── Test 5: cancelAllOrders transitions all to CANCELLED ───────────────
{
  const exec = new LiveExecutionEngine({
    cfg, logger: log,
    client: new MockClient(),
    wallet: new MockWallet(),
  });

  await exec.placeOrder({ signalKey: "ca:1", tokenId: "t1", side: "BUY", price: 0.4, size: 5 });
  await exec.placeOrder({ signalKey: "ca:2", tokenId: "t2", side: "BUY", price: 0.5, size: 5 });
  await exec.placeOrder({ signalKey: "ca:3", tokenId: "t3", side: "BUY", price: 0.6, size: 5 });

  assert("cancelAll:3 open orders", exec.orders.listOpenOrders().length === 3);

  const r = await exec.cancelAllOrders();
  assert("cancelAll:success", r.success);
  assert("cancelAll:0 open after", exec.orders.listOpenOrders().length === 0);

  for (const o of exec.orders.listAll()) {
    assert(`cancelAll:${o.orderId} terminal`, ["CANCELLED", "FILLED", "FAILED"].includes(o.state));
  }
}

// ─── Test 6: snapshot aggregates all stores ─────────────────────────────
{
  const exec = new LiveExecutionEngine({
    cfg, logger: log,
    client: new MockClient(),
    wallet: new MockWallet(),
  });

  const r = await exec.placeOrder({ signalKey: "snap:1", tokenId: "tx", side: "BUY", price: 0.5, size: 10 });
  exec.applyFill({ orderId: r.orderId, fillSize: 10, fillPrice: 0.5 });

  const s = exec.snapshot();
  assert("snap:has orders", s.orders.total >= 1);
  assert("snap:has positions", s.positions.count >= 1);
  assert("snap:has risk", s.risk && typeof s.risk.day === "string");
  assert("snap:has dedupe", s.dedupe && typeof s.dedupe.size === "number");
}

// ─── Summary ────────────────────────────────────────────────────────────
const pass = results.filter(r => r.pass).length;
const fail = results.filter(r => !r.pass);
console.log(`\n═══════════════════════════════════════════════════`);
console.log(`  Execution flow tests: ${results.length} total, ${pass} passed, ${fail.length} failed`);
console.log(`═══════════════════════════════════════════════════`);
process.exit(fail.length > 0 ? 1 : 0);
