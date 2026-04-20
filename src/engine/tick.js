// ═══════════════════════════════════════════════════════════════════════
//  engine/tick.js — state init + main simulation loop
// ═══════════════════════════════════════════════════════════════════════
//  Pure. Input (prev state, time) → new state. No React, no I/O.
//
//  tick orchestrates:
//    market → alpha → risk → execution → portfolio → system
//
//  Exports:
//   - initState   (fresh deterministic state from seed)
//   - tick        (one simulation step)

import { CFG } from "../config/config.js";
import { MDEFS } from "../config/marketDefs.js";
import { createRng } from "./prng.js";
import { pushHist } from "./history.js";
import { detectRegime, computeWeights } from "./regime.js";
import {
  createLOB, refreshLOB, advMkt, validateMarket,
  computeMarketImpact, computeCorrelationMatrix,
} from "./market.js";
import {
  genNews, nlpSigs, momSigs, arbSigs, orderflowSigs, processSigs,
} from "./alpha.js";
import { preTradeRisk, calcExposure } from "./risk.js";
import {
  TERMINAL, createOrder, advanceOrderFills, resolvePartialFill,
} from "./execution.js";
import {
  applyFills, applyAttributionEvents, computeMetrics,
} from "./portfolio.js";
import {
  reconcile, updateCB, recordReject, recordApproval,
  recordSlipEvent, recordPoorFill, recordInvalidData,
  appendEventLog, computePerformanceMetrics, pruneOrderHistory,
} from "./system.js";

/** Initial deterministic state from seed. */
export function initState(seed = 42) {
  const rng = createRng(seed);
  const markets = {}, histories = {}, lobs = {};
  for (const d of MDEFS) {
    markets[d.id] = { id: d.id, q: d.q, yes: d.init, prevYes: d.init, vol: d.vol, cat: d.cat, adv: d.adv, lastUpdate: 0 };
    histories[d.id] = { prices: [], spreads: [], depths: [], maxLen: 300 };
    lobs[d.id] = createLOB(d.init, d.adv, rng);
  }
  return {
    seed, tickCount: 0, time: 0, markets, histories, lobs,
    regime: { trend: "neutral", vol: "low_vol", liq: "high_liq", confidence: 0, hurst: 0.5 },
    alphaWeights: { nlp: 0.33, momentum: 0.33, arb: 0.33 },
    metaPerf: { nlp: [], momentum: [], arb: [] },
    newsIntensity: 0,
    signals: [], newsLog: [], recommendations: [],
    orders: [], orderHistory: [],
    fills: [], fillKeys: {},
    positions: {},
    equity: CFG.initialEquity, equityCurve: [CFG.initialEquity],
    peakEquity: CFG.initialEquity,
    grossExposure: 0, netExposure: 0, totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0, currentDD: 0,
    cb: {
      state: "closed", failCount: 0, lastFailTime: 0, reason: null, triggers: [],
      recentSlipEvents: [], recentRejects: [], recentPoorFills: [], recentInvalidData: [],
      halfOpenNotional: 0, halfOpenFills: 0,
    },
    quarantined: {},
    monitor: { approvals: 0, rejections: 0, signalCounts: { nlp: 0, momentum: 0, arb: 0 } },
    events: [],
    lastRecon: { ok: true, issues: 0, drifts: 0, orphans: 0, fills: 0, orders: 0 },
    spawnStats: { existing: 0, new: 0, deferred: 0 },
    deferredSpawns: [], orderSeq: 0,
    corrMatrix: {},
    eventLog: [],
    perfMetrics: { sharpe: 0, winRate: 0, avgSlipBps: 0, execQuality: 0, alphaContrib: {} },
    equityReturns: [],
    impactDecay: {},
  };
}

/**
 * One simulation step: pure function of (prev, tickTime) → next state.
 *
 * Pipeline:
 *  1. Impact decay from prior large trades
 *  2. Market price advance
 *  3. LOB refresh
 *  4. History update
 *  5. Market validation (feeds CB on invalid data)
 *  6. Regime detection
 *  7. Correlation matrix refresh (every 5 ticks)
 *  8. Alpha weight computation
 *  9. Signal generation (news/NLP/momentum/arb/orderflow)
 * 10. Signal processing into sized recommendations
 * 11. Existing-order advancement + partial-fill resolution (with spawn queue)
 * 12. New-order creation from recommendations (pre-trade risk gated)
 * 13. Apply fills → positions; emit attribution events
 * 14. Reconciliation (with self-healing)
 * 15. Metrics + CB update + history prune
 * 16. Perf metrics (Sharpe/win-rate/slippage/alpha contribution)
 */
export function tick(prev, tickTime) {
  const rng = createRng(prev.seed + prev.tickCount * 7919);
  const time = tickTime;
  const s = { ...prev, tickCount: prev.tickCount + 1, time, events: [] };
  const seqRef = { val: prev.orderSeq || 0 };
  let eventLog = [...(prev.eventLog || [])];

  // 1. Decay market impact
  const impactDecay = {};
  for (const [mid, entry] of Object.entries(prev.impactDecay || {})) {
    if (entry.remaining > 0) impactDecay[mid] = { ...entry, remaining: entry.remaining - 1 };
  }

  // 2. Markets
  const newMkts = {};
  for (const [id, m] of Object.entries(s.markets)) newMkts[id] = advMkt(m, rng, time, impactDecay);
  s.markets = newMkts;

  // 3. LOBs
  const newLobs = {};
  for (const [id, m] of Object.entries(s.markets)) {
    const prevLob = s.lobs[id] || createLOB(m.yes, m.adv, rng);
    newLobs[id] = refreshLOB(prevLob, m.yes, m.adv, s.regime, rng);
  }
  s.lobs = newLobs;

  // 4. Histories
  const newH = {};
  for (const [id, m] of Object.entries(s.markets)) {
    const lob = s.lobs[id];
    newH[id] = pushHist(s.histories[id] || { prices: [], spreads: [], depths: [], maxLen: 300 }, m.yes, lob.spread, lob.bidDepth);
  }
  s.histories = newH;

  // 5. Market validation
  const quarantined = {};
  let cb = {
    ...s.cb, triggers: [...s.cb.triggers],
    recentSlipEvents: [...(s.cb.recentSlipEvents || [])],
    recentPoorFills: [...(s.cb.recentPoorFills || [])],
    recentInvalidData: [...(s.cb.recentInvalidData || [])],
    recentRejects: [...(s.cb.recentRejects || [])],
  };
  for (const [id, m] of Object.entries(s.markets)) {
    const lob = s.lobs[id];
    const v = validateMarket(m, lob, time);
    if (!v.valid) {
      quarantined[id] = v.issues;
      s.events.push({ evt: "mkt:invalid", ts: time, s: id + ":" + v.issues.join(",") });
      cb = recordInvalidData(cb, id, time);
    }
  }
  s.quarantined = quarantined;

  // 6. Regime
  const mH = s.histories["btc150k"] || Object.values(s.histories)[0];
  if (mH && mH.prices.length > 30) s.regime = detectRegime(mH.prices, mH.spreads, mH.depths);

  // 7. Correlation matrix (every 5 ticks)
  if (s.tickCount % 5 === 0) {
    s.corrMatrix = computeCorrelationMatrix(s.histories, MDEFS.map(d => d.id));
  } else {
    s.corrMatrix = prev.corrMatrix || {};
  }

  // 8. Alpha weights
  s.alphaWeights = computeWeights(s.regime, s.metaPerf, s.newsIntensity);

  // 9. Signals
  let sigs = [...s.signals];
  if (rng() < 0.3) {
    const nev = genNews(s.markets, rng, time);
    s.newsLog = [nev, ...s.newsLog].slice(0, 60);
    s.newsIntensity = nev.impactClass === "binary_catalyst" ? 0.9 : nev.impactClass === "gradual_shift" ? 0.5 : 0.1;
    const ns = nlpSigs(nev, s.markets, time);
    sigs.push(...ns);
    s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, nlp: s.monitor.signalCounts.nlp + ns.length } };
    s.events.push({ evt: "news", ts: time, s: nev.impactClass + "|" + nev.headline.slice(0, 25) });
    eventLog = appendEventLog(eventLog, s.tickCount, time, "NEWS", { headline: nev.headline, impact: nev.impactClass });
  }
  const ms2 = momSigs(s.markets, s.histories, time, s.regime);
  sigs = sigs.filter(x => x.source !== "momentum"); sigs.push(...ms2);
  s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, momentum: s.monitor.signalCounts.momentum + ms2.length } };
  if (rng() < 0.35) {
    const as2 = arbSigs(s.markets, s.histories, time);
    sigs = sigs.filter(x => x.source !== "arb"); sigs.push(...as2);
    s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, arb: s.monitor.signalCounts.arb + as2.length } };
  }
  const ofSigs = orderflowSigs(s.markets, s.lobs, time);
  sigs.push(...ofSigs);

  // 10. Recommendations
  const liveStateForSizing = {
    equity: s.equity, currentDD: s.currentDD, grossExposure: s.grossExposure,
    positions: s.positions, markets: s.markets, cbState: cb.state,
  };
  const { filtered, recs } = processSigs(sigs, s.alphaWeights, s.regime.confidence, time, liveStateForSizing);
  s.signals = filtered.slice(0, 80);
  s.recommendations = [...recs, ...s.recommendations].slice(0, 40);

  // 11. Orders + Execution
  let positions = {}; for (const [k, v] of Object.entries(s.positions)) positions[k] = { ...v };
  let fills = [...s.fills], fillKeys = { ...s.fillKeys };
  let orders = s.orders.map(o => ({ ...o, children: o.children.map(c => ({ ...c })) }));
  let orderHistory = [...s.orderHistory]; let monitor = { ...s.monitor };
  let metaPerf = { nlp: [...s.metaPerf.nlp], momentum: [...s.metaPerf.momentum], arb: [...s.metaPerf.arb] };
  let allNewFills = [];
  let currentLobs = { ...s.lobs };
  let newImpactDecay = { ...impactDecay };

  function processOrder(ord) {
    const { order: advanced, newFills: nf, childSlipRejects, updatedLobs } = advanceOrderFills(ord, rng, s.markets, currentLobs, time, fillKeys);
    for (const [mid, lobUpdate] of Object.entries(updatedLobs)) currentLobs[mid] = lobUpdate;
    allNewFills.push(...nf);
    for (const f of nf) fillKeys[f.key] = true;
    for (const f of nf) {
      if (f.qty > 20) {
        const impact = computeMarketImpact(f.qty, s.markets[f.cid]?.adv || 10000, f.side === "YES" ? "buy" : "sell");
        if (Math.abs(impact.totalImpact) > 0.0001) {
          newImpactDecay[f.cid] = { tempImpact: impact.tempImpact, permImpact: impact.permImpact, remaining: CFG.impactDecayTicks };
        }
      }
    }
    if (childSlipRejects > 0) { for (let i = 0; i < childSlipRejects; i++) cb = recordSlipEvent(cb, CFG.maxSlipBps + 1, time); }
    if (advanced.slipBps != null) cb = recordSlipEvent(cb, advanced.slipBps, time);
    if (advanced.status === "REJECTED") cb = recordReject(cb, "order_reject", advanced.id, s.events, time);
    const pendingChildren = advanced.children.filter(c => c.st === "NEW" || c.st === "ACCEPTED");
    if (pendingChildren.length === 0 && advanced.fillRate < 0.3 && advanced.parentSz > 50) cb = recordPoorFill(cb, time);
    if (cb.state === "half_open" && nf.length > 0) {
      let pn = 0; for (const f of nf) pn += f.qty * f.px;
      cb = { ...cb, halfOpenNotional: cb.halfOpenNotional + pn, halfOpenFills: (cb.halfOpenFills || 0) + nf.length };
    }
    const { order: resolved, spawned } = resolvePartialFill(advanced, s.markets, currentLobs, time, rng, seqRef);
    if (resolved.partialAction) s.events.push({ evt: "partial:" + resolved.partialAction.action.toLowerCase(), ts: time, s: resolved.cid + "|" + resolved.partialAction.reason });
    for (const f of nf) eventLog = appendEventLog(eventLog, s.tickCount, time, "FILL", { key: f.key, qty: f.qty, px: f.px, side: f.side, cid: f.cid });
    return { resolved, spawned };
  }

  function drainSpawnQueue(initialOrders) {
    const active = [], terminal = [], spawnQueue = []; let totalSpawns = 0; const deferred = [];
    for (const o of initialOrders) {
      if (TERMINAL.has(o.status)) { terminal.push(o); continue; }
      const { resolved, spawned } = processOrder(o);
      if (TERMINAL.has(resolved.status)) terminal.push(resolved); else active.push(resolved);
      for (const sp of spawned) spawnQueue.push({ order: sp, depth: 1 });
      if (resolved.totalFilled > 0) s.events.push({ evt: "exec:advance", ts: time, s: resolved.cid + "|" + resolved.status + "|f=" + resolved.totalFilled });
    }
    while (spawnQueue.length > 0) {
      const { order: spOrd, depth } = spawnQueue.shift();
      if (depth > CFG.maxSpawnDepth || totalSpawns >= CFG.maxSpawnsPerTick) { deferred.push(spOrd); continue; }
      totalSpawns++;
      const { resolved: spRes, spawned: spSp } = processOrder(spOrd);
      if (TERMINAL.has(spRes.status)) terminal.push(spRes); else active.push(spRes);
      for (const ss of spSp) spawnQueue.push({ order: ss, depth: depth + 1 });
    }
    return { active, terminal, deferred, totalSpawns };
  }

  const prevDeferred = s.deferredSpawns || []; let deferredSpawns = [];
  if (prevDeferred.length > 0) {
    const defResult = drainSpawnQueue(prevDeferred);
    orders.push(...defResult.active); orderHistory.push(...defResult.terminal); deferredSpawns.push(...defResult.deferred);
  }
  const existingResult = drainSpawnQueue(orders);
  orders = existingResult.active; orderHistory.push(...existingResult.terminal); deferredSpawns.push(...existingResult.deferred);

  // 12. New orders from recs
  const snap = { positions, markets: s.markets, cb, currentDD: s.currentDD, grossExposure: calcExposure(positions, s.markets).gross, quarantined, corrMatrix: s.corrMatrix };
  const newOrdersFromRecs = [];
  for (const rec of recs) {
    const liveExp = calcExposure(positions, s.markets);
    const verdict = preTradeRisk(rec, { ...snap, grossExposure: liveExp.gross });
    if (verdict.ok) { monitor.approvals++; cb = recordApproval(cb); } else { monitor.rejections++; cb = recordReject(cb, "risk_reject", rec.cid, s.events, time); }
    s.events.push({ evt: verdict.ok ? "risk:pass" : "risk:reject", ts: time, s: rec.cid + "|sz=" + verdict.sz });
    const ord = createOrder(rec, verdict, s.markets, currentLobs, time, rng, seqRef.val++);
    if (ord) {
      newOrdersFromRecs.push(ord);
      eventLog = appendEventLog(eventLog, s.tickCount, time, "ORDER", { id: ord.id, side: ord.side, sz: ord.parentSz, strat: ord.strat });
    }
  }
  const newResult = drainSpawnQueue(newOrdersFromRecs);
  orders.push(...newResult.active); orderHistory.push(...newResult.terminal); deferredSpawns.push(...newResult.deferred);
  const seenDef = new Set();
  deferredSpawns = deferredSpawns.filter(d => { if (seenDef.has(d.id)) return false; seenDef.add(d.id); return true; });

  // 13. Apply fills
  const fResult = applyFills(positions, fills, fillKeys, allNewFills);
  positions = fResult.positions; fills = fResult.fills; fillKeys = fResult.fillKeys;
  metaPerf = applyAttributionEvents(metaPerf, fResult.attrEvents);

  // 14. Reconciliation
  const reconResult = reconcile(positions, fills, fillKeys, orders, orderHistory);
  if (!reconResult.ok) {
    positions = reconResult.correctedPositions; fillKeys = reconResult.correctedFillKeys;
    const fixedOrders = [];
    for (const o of orders) { if (TERMINAL.has(o.status)) { orderHistory.push(o); } else fixedOrders.push(o); }
    orders = fixedOrders;
  }
  s.events.push({ evt: "recon:done", ts: time, s: "ok=" + reconResult.ok + "|issues=" + reconResult.issues.length });

  // 15. Metrics + CB + prune
  const metrics = computeMetrics(positions, s.markets, s.equityCurve, s.peakEquity);
  cb = updateCB(cb, metrics, time);
  orderHistory = pruneOrderHistory(orderHistory, orders);

  // 16. Perf metrics
  const prevEquity = prev.equity || CFG.initialEquity;
  const equityReturn = prevEquity > 0 ? (metrics.equity - prevEquity) / prevEquity : 0;
  let equityReturns = [...(prev.equityReturns || []), equityReturn];
  if (equityReturns.length > CFG.metricsWindow) equityReturns = equityReturns.slice(-CFG.metricsWindow);
  const perfMetrics = computePerformanceMetrics(equityReturns, fills, metaPerf);

  return {
    ...s, positions, fills, fillKeys, orders, orderHistory, deferredSpawns,
    lobs: currentLobs,
    equity: metrics.equity, equityCurve: metrics.equityCurve,
    peakEquity: metrics.peakEquity, grossExposure: metrics.grossExposure,
    netExposure: metrics.netExposure, totalPnl: metrics.totalPnl,
    realizedPnl: metrics.realizedPnl, unrealizedPnl: metrics.unrealizedPnl,
    currentDD: metrics.currentDD, cb, monitor, metaPerf,
    orderSeq: seqRef.val,
    impactDecay: newImpactDecay,
    eventLog, equityReturns, perfMetrics,
    lastRecon: { ok: reconResult.ok, issues: reconResult.issues.length, drifts: reconResult.driftCount, orphans: reconResult.orphanFills, fills: reconResult.fillCount, orders: reconResult.orderCount },
    spawnStats: { existing: existingResult.totalSpawns, new: newResult.totalSpawns, deferred: deferredSpawns.length },
  };
}
