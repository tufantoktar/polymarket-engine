// ═══════════════════════════════════════════════════════════════════════
//  tests/runTests.js — deterministic test suite for the engine
// ═══════════════════════════════════════════════════════════════════════
//  Pure function: no I/O, no mocks. Returns array of {name, pass}.
//  Invoked from the Tests tab in App.jsx.

import { CFG } from "../config/config.js";
import { createRng } from "../engine/prng.js";
import {
  createLOB, refreshLOB, matchOrderAgainstLOB,
  computeMarketImpact, applyAdverseSelection,
  computeCorrelationMatrix,
} from "../engine/market.js";
import { momSigs, orderflowSigs } from "../engine/alpha.js";
import { canTransition, computeAdaptiveLimit } from "../engine/execution.js";
import { preTradeRisk } from "../engine/risk.js";
import { applyFills } from "../engine/portfolio.js";
import {
  updateCB, appendEventLog, computePerformanceMetrics, pruneOrderHistory,
} from "../engine/system.js";
import { initState, tick } from "../engine/tick.js";

export function runTests() {
  const results = [];
  const assert = (name, cond) => { results.push({ name, pass: !!cond }); };

  // --- PHASE 1: LOB TESTS ---
  { const rng = createRng(42); const lob = createLOB(0.5, 12000, rng);
    assert("lob:has bids", lob.bids.length === CFG.lobLevels);
    assert("lob:has asks", lob.asks.length === CFG.lobLevels);
    assert("lob:spread positive", lob.spread > 0);
    assert("lob:bestBid < bestAsk", lob.bestBid < lob.bestAsk);
    assert("lob:bidDepth > 0", lob.bidDepth > 0);
  }
  { const rng = createRng(42); const lob = createLOB(0.5, 12000, rng);
    const prevAskDepth = lob.askDepth;
    const result = matchOrderAgainstLOB(lob, "buy", 50, 0.99, "test1", 1000);
    assert("lob:match fills qty", result.totalFilled === 50);
    assert("lob:match has fills", result.fills.length >= 1);
    assert("lob:depth consumed", result.updatedLob.askDepth < prevAskDepth);
    assert("lob:avg price valid", result.avgPx > 0 && result.avgPx < 1);
  }
  { const rng = createRng(42); const lob = createLOB(0.5, 12000, rng);
    const result = matchOrderAgainstLOB(lob, "buy", 50, 0.01, "test2", 1000);
    assert("lob:no fill beyond limit", result.totalFilled === 0);
    assert("lob:remaining equals qty", result.remainingQty === 50);
  }
  { const rng = createRng(42); const lob1 = createLOB(0.5, 12000, rng);
    const m1 = matchOrderAgainstLOB(lob1, "buy", lob1.askDepth - 10, 0.99, "drain", 1000);
    assert("lob:drain leaves little depth", m1.updatedLob.askDepth < 20);
    const rng2 = createRng(43);
    const refreshed = refreshLOB(m1.updatedLob, 0.5, 12000, { vol: "low_vol", liq: "high_liq" }, rng2);
    assert("lob:refresh replenishes depth", refreshed.askDepth > m1.updatedLob.askDepth);
  }

  // --- PHASE 2: MARKET IMPACT ---
  { const i1 = computeMarketImpact(100, 12000, "buy");
    const i2 = computeMarketImpact(100, 12000, "sell");
    assert("impact:buy positive", i1.totalImpact > 0);
    assert("impact:sell negative", i2.totalImpact < 0);
    const i3 = computeMarketImpact(400, 12000, "buy");
    assert("impact:larger order bigger impact", Math.abs(i3.totalImpact) > Math.abs(i1.totalImpact));
  }
  { const newMid = applyAdverseSelection(0.55, 0.50, "buy");
    assert("adverse:buy moves mid up", newMid > 0.50);
    const newMid2 = applyAdverseSelection(0.45, 0.50, "sell");
    assert("adverse:sell moves mid down", newMid2 < 0.50);
  }

  // --- PHASE 3: ALPHA ---
  { const mkts = { btc150k: { id: "btc150k", yes: 0.55, prevYes: 0.50, vol: 0.02, cat: "crypto", adv: 12000 } };
    const prices = []; for (let i = 0; i < 60; i++) prices.push(0.40 + i * 0.003);
    const hists = { btc150k: { prices, spreads: prices.map(() => 0.02), depths: prices.map(() => 200), maxLen: 300 } };
    const sigs = momSigs(mkts, hists, 100000, { trend: "trending", vol: "low_vol", liq: "high_liq" });
    assert("mom:produces signals on trend", sigs.length > 0);
    if (sigs.length > 0) assert("mom:detects uptrend", sigs[0].dir === "BUY_YES");
  }
  { const mkts = { btc150k: { id: "btc150k", yes: 0.5, vol: 0.02, cat: "crypto", adv: 12000 } };
    const lobs = { btc150k: { bidDepth: 500, askDepth: 100, volumeThisTick: 50, bids: [], asks: [] } };
    const sigs = orderflowSigs(mkts, lobs, 1000);
    assert("oflow:detects bid imbalance", sigs.length > 0);
    if (sigs.length > 0) assert("oflow:direction is BUY_YES on bid pressure", sigs[0].dir === "BUY_YES");
  }

  // --- PHASE 4: PORTFOLIO ---
  { const rng = createRng(42);
    const pA = [0.5], pB = [0.5];
    for (let i = 1; i < 50; i++) {
      const noise = (rng() - 0.5) * 0.006;
      pA.push(pA[i-1] + noise);
      pB.push(pB[i-1] - noise * 0.8);
    }
    const hists = { a: { prices: pA }, b: { prices: pB } };
    const cm = computeCorrelationMatrix(hists, ["a", "b"]);
    assert("corr:self is 1", cm["a:a"] === 1);
    assert("corr:negative corr detected", cm["a:b"] < -0.5);
  }

  // --- PHASE 5: SMART EXECUTION ---
  { const lob = { bestBid: 0.48, bestAsk: 0.52, spread: 0.04, midPrice: 0.50 };
    const aggLim = computeAdaptiveLimit(lob, "YES", "immediate");
    const patLim = computeAdaptiveLimit(lob, "YES", "patient");
    assert("adaptive:immediate crosses spread", aggLim === 0.52);
    assert("adaptive:patient inside spread", patLim > 0.48 && patLim < 0.52);
  }

  // --- PHASE 6: EVENT SOURCING ---
  { let log = [];
    log = appendEventLog(log, 1, 1000, "TEST", { x: 1 });
    assert("eventlog:appends", log.length === 1);
    for (let i = 0; i < 2100; i++) log = appendEventLog(log, i, i * 1000, "BULK", { i });
    assert("eventlog:bounded", log.length <= 2000);
    assert("eventlog:keeps recent", log[log.length - 1].data.i === 2099);
  }

  // --- PHASE 7: METRICS ---
  { const returns = [0.01, -0.005, 0.008, -0.003, 0.012, 0.006, -0.002, 0.009, 0.004, -0.001];
    const fills = [{ slipBps: 5 }, { slipBps: 10 }, { slipBps: 3 }];
    const mp = { nlp: [0.5, -0.2, 0.3], momentum: [0.1, 0.4], arb: [-0.1] };
    const pm = computePerformanceMetrics(returns, fills, mp);
    assert("metrics:sharpe computed", typeof pm.sharpe === "number" && pm.sharpe !== 0);
    assert("metrics:avgSlipBps computed", pm.avgSlipBps === 6);
    assert("metrics:winRate computed", pm.winRate > 0);
    assert("metrics:alphaContrib has sources", "nlp" in pm.alphaContrib);
  }

  // --- PRESERVED CORE TESTS ---
  { assert("fsm:FILLED→any blocked", !canTransition("FILLED", "CANCELLED"));
    assert("fsm:REPLACED→any blocked", !canTransition("REPLACED", "FILLED"));
    assert("fsm:NEW→ACCEPTED valid", canTransition("NEW", "ACCEPTED"));
  }
  { const f1 = { key: "dup1", orderId: "o1", cid: "btc150k", side: "YES", qty: 50, px: 0.45, time: 1000, slipBps: 2, attr: { nlp: 100 } };
    const r1 = applyFills({}, [], {}, [f1]);
    assert("dedup:first applied", r1.fills.length === 1);
    const r2 = applyFills(r1.positions, r1.fills, r1.fillKeys, [f1]);
    assert("dedup:duplicate rejected", r2.fills.length === 1);
  }
  { const f1 = { key: "ao1", orderId: "o1", cid: "btc150k", side: "YES", qty: 100, px: 0.40, time: 1000, slipBps: 1, attr: { nlp: 100 } };
    const r1 = applyFills({}, [], {}, [f1]);
    assert("attr:opening no events", r1.attrEvents.length === 0);
    const f2 = { key: "ao2", orderId: "o2", cid: "btc150k", side: "NO", qty: 60, px: 0.50, time: 2000, slipBps: 1, attr: { arb: 100 } };
    const r2 = applyFills(r1.positions, r1.fills, r1.fillKeys, [f2]);
    assert("attr:closing emits event", r2.attrEvents.length === 1);
    assert("attr:rpnl = 60*(0.50-0.40)=6", Math.abs(r2.attrEvents[0].rpnl - 6) < 0.01);
  }
  { const s1 = initState(42); const s2 = initState(42);
    const t1 = tick(s1, 10000); const t2 = tick(s2, 10000);
    assert("det:same equity", t1.equity === t2.equity);
    assert("det:same fills", t1.fills.length === t2.fills.length);
    assert("det:same orderSeq", t1.orderSeq === t2.orderSeq);
  }
  { const empty = pruneOrderHistory([], []);
    assert("prune:empty→array", Array.isArray(empty) && empty.length === 0);
    const big = []; for (let i = 0; i < 500; i++) big.push({ id: "h" + i, status: "FILLED", parentOrderId: null, replacedBy: null });
    const pruned = pruneOrderHistory(big, []);
    assert("prune:flat array", Array.isArray(pruned) && pruned.every(o => !Array.isArray(o)));
  }
  { const cb1 = { state: "half_open", failCount: 1, lastFailTime: 1000, reason: "test", triggers: [], recentSlipEvents: [], recentRejects: [], recentPoorFills: [], recentInvalidData: [], halfOpenNotional: 0, halfOpenFills: 0 };
    assert("cb:no fills → stays half_open", updateCB(cb1, { currentDD: 0, grossExposure: 0 }, 5000).state === "half_open");
    const cb2 = { ...cb1, halfOpenFills: CFG.cbHalfOpenProbeMinFills };
    assert("cb:fills → closes", updateCB(cb2, { currentDD: 0, grossExposure: 0 }, 5000).state === "closed");
  }
  { const snap = { positions: {}, markets: { btc150k: { id: "btc150k", yes: 0.25, cat: "crypto", adv: 12000 } }, cb: { state: "half_open" }, currentDD: 0, grossExposure: 0, quarantined: {}, corrMatrix: {} };
    const v = preTradeRisk({ cid: "btc150k", dir: "BUY_YES", sz: 5000, aq: 0.5 }, snap);
    assert("half_open:qty capped by notional/price", v.sz <= Math.floor(CFG.cbHalfOpenMaxNotional / 0.25));
    assert("half_open:notional within cap", v.sz * 0.25 <= CFG.cbHalfOpenMaxNotional);
  }
  { const lob1 = createLOB(0.5, 12000, createRng(99));
    const lob2 = createLOB(0.5, 12000, createRng(99));
    const r1 = matchOrderAgainstLOB(lob1, "buy", 100, 0.6, "t1", 1000);
    const r2 = matchOrderAgainstLOB(lob2, "buy", 100, 0.6, "t2", 1000);
    assert("lob:deterministic fills", r1.totalFilled === r2.totalFilled);
    assert("lob:deterministic price", r1.avgPx === r2.avgPx);
  }

  return results;
}
