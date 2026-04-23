// ═══════════════════════════════════════════════════════════════════════
//  engine/system.js — reconciliation, circuit breaker, event log,
//                     perf metrics, history pruning
// ═══════════════════════════════════════════════════════════════════════
//  Pure functions. All inputs/outputs explicit.
//
//  Exports:
//   - reconcile                 (integrity check + self-healing state)
//   - tripCB, updateCB          (CB state machine)
//   - recordReject, recordApproval, recordSlipEvent,
//     recordPoorFill, recordInvalidData   (CB event trackers)
//   - appendEventLog            (append-only structured log, bounded)
//   - computePerformanceMetrics (Sharpe, win rate, slippage, exec quality)
//   - collectProtectedOrderIds  (retention-safe id set)
//   - pruneOrderHistory         (bounded history trim)

import { CFG } from "../config/config.js";
import { TERMINAL } from "./execution.js";
import { rebuildPositionsFromFills } from "./portfolio.js";

// ═══════════════════════ RECONCILIATION ═══════════════════════════════
/**
 * Full-state integrity check. Rebuilds positions from fills, compares to
 * live `positions`, and scans for orphan fills / FSM inconsistencies /
 * lineage breaks / ledger drift. Returns issues list + self-healing
 * correctedPositions/correctedFillKeys (for drift recovery).
 */
export function reconcile(livePositions, fills, fillKeys, orders, orderHistory) {
  const issues = [];
  const rebuilt = rebuildPositionsFromFills(fills);
  const allMids = new Set([...Object.keys(livePositions), ...Object.keys(rebuilt)]);
  let positionsDrifted = false;

  for (const mid of allMids) {
    const live = livePositions[mid] || { yesQty: 0, noQty: 0, realizedPnl: 0 };
    const rb = rebuilt[mid] || { yesQty: 0, noQty: 0, realizedPnl: 0 };
    if (Math.abs(live.yesQty - rb.yesQty) > 0.01 || Math.abs(live.noQty - rb.noQty) > 0.01 || Math.abs(live.realizedPnl - rb.realizedPnl) > 0.01) {
      issues.push({ type: "position_drift", market: mid });
      positionsDrifted = true;
    }
  }

  const seenKeys = {};
  for (const f of fills) {
    if (seenKeys[f.key]) issues.push({ type: "duplicate_fill_in_ledger", key: f.key });
    seenKeys[f.key] = true;
  }

  const allOrders = [...orders, ...orderHistory];
  const fillsByOrder = {};
  for (const f of fills) { (fillsByOrder[f.orderId] || (fillsByOrder[f.orderId] = [])).push(f); }

  for (const ord of allOrders) {
    const of2 = fillsByOrder[ord.id] || [];
    const fqs = of2.reduce((s, f) => s + f.qty, 0);
    if (ord.status === "FILLED" && Math.abs(fqs - ord.parentSz) > 0.01) issues.push({ type: "filled_qty_mismatch", orderId: ord.id });
    if (ord.status === "PARTIALLY_FILLED" && (fqs <= 0 || fqs >= ord.parentSz)) issues.push({ type: "partial_qty_inconsistent", orderId: ord.id });
    if (Math.abs((ord.totalFilled || 0) - fqs) > 0.01) issues.push({ type: "order_fill_total_mismatch", orderId: ord.id });
  }

  const orderIds = new Set(allOrders.map(o => o.id));
  for (const f of fills) {
    if (!orderIds.has(f.orderId)) issues.push({ type: "orphan_fill", fillKey: f.key });
  }

  for (const o of orders) {
    if (TERMINAL.has(o.status)) issues.push({ type: "terminal_in_active", orderId: o.id });
  }

  for (const o of allOrders) {
    if (o.status === "REPLACED" && o.replacedBy) {
      const rpl = allOrders.find(r => r.id === o.replacedBy);
      if (!rpl) issues.push({ type: "replacement_missing", orderId: o.id });
      else if (rpl.parentOrderId !== o.id) issues.push({ type: "replacement_lineage_mismatch", orderId: o.id });
    }
    if (o.parentOrderId && o.id.includes("unwind")) {
      if (!allOrders.find(p => p.id === o.parentOrderId)) issues.push({ type: "unwind_parent_missing", orderId: o.id });
    }
  }

  const ledgerKeys = new Set(fills.map(f => f.key));
  for (const k of Object.keys(fillKeys)) {
    if (!ledgerKeys.has(k)) issues.push({ type: "stale_fill_key", key: k });
  }
  for (const k of ledgerKeys) {
    if (!fillKeys[k]) issues.push({ type: "missing_fill_key", key: k });
  }

  const correctedPositions = positionsDrifted ? rebuilt : livePositions;
  const correctedFillKeys = {};
  for (const f of fills) correctedFillKeys[f.key] = true;

  return {
    ok: issues.length === 0, issues,
    correctedPositions, correctedFillKeys, rebuiltPositions: rebuilt,
    fillCount: fills.length, orderCount: allOrders.length,
    orphanFills: issues.filter(i => i.type === "orphan_fill").length,
    driftCount: issues.filter(i => i.type === "position_drift").length,
  };
}

// ═══════════════════════ CIRCUIT BREAKER ══════════════════════════════
export function tripCB(cb, reason, time) {
  return {
    ...cb, state: "open", reason, lastFailTime: time,
    failCount: (cb.failCount || 0) + 1,
    triggers: [...cb.triggers, { t: time, r: reason, from: cb.state, to: "open" }],
    halfOpenNotional: 0, halfOpenFills: 0,
  };
}

/** Evaluate CB state transitions + trip thresholds. */
export function updateCB(cb, metrics, time) {
  let next = {
    ...cb,
    triggers: [...cb.triggers],
    recentSlipEvents: [...(cb.recentSlipEvents || [])],
    recentPoorFills: [...(cb.recentPoorFills || [])],
    recentInvalidData: [...(cb.recentInvalidData || [])],
    recentRejects: [...(cb.recentRejects || [])],
  };

  if (next.state === "open" && time - next.lastFailTime > CFG.cbRecoveryMs) {
    next.triggers = [...next.triggers, { t: time, r: "recovery_timer", from: "open", to: "half_open" }];
    next.state = "half_open"; next.halfOpenNotional = 0; next.halfOpenFills = 0;
  }
  if (next.state === "half_open" && next.halfOpenFills >= CFG.cbHalfOpenProbeMinFills && next.recentRejects.length === 0) {
    next.triggers = [...next.triggers, { t: time, r: "probe_success: fills=" + next.halfOpenFills, from: "half_open", to: "closed" }];
    next.state = "closed"; next.failCount = 0; next.reason = null;
    next.halfOpenNotional = 0; next.halfOpenFills = 0;
  }
  if (next.state !== "open" && metrics.currentDD > CFG.maxDD) next = tripCB(next, "drawdown_breach: " + (metrics.currentDD * 100).toFixed(1) + "%", time);
  if (next.state !== "open" && metrics.grossExposure > CFG.maxExpNotional * CFG.cbExpBreachMultiplier) next = tripCB(next, "exposure_breach: " + metrics.grossExposure.toFixed(0), time);

  const highSlip = next.recentSlipEvents.filter(e => e.slipBps > CFG.maxSlipBps * 0.8).length;
  if (next.state !== "open" && highSlip >= CFG.cbSlipThreshold) { next = tripCB(next, "excessive_slippage: " + highSlip, time); next.recentSlipEvents = []; }
  if (next.state !== "open" && next.recentRejects.length >= CFG.cbRejectThreshold) { next = tripCB(next, "repeated_rejects: " + next.recentRejects.length, time); next.recentRejects = []; }
  if (next.state !== "open" && next.recentPoorFills.length >= CFG.cbPoorFillThreshold) { next = tripCB(next, "poor_fills: " + next.recentPoorFills.length, time); next.recentPoorFills = []; }
  if (next.state !== "open" && next.recentInvalidData.length >= CFG.cbInvalidDataThreshold) { next = tripCB(next, "invalid_market_data: " + next.recentInvalidData.length, time); next.recentInvalidData = []; }

  if (next.triggers.length > 30) next.triggers = next.triggers.slice(-25);
  return next;
}

// ═══════════════════════ CB EVENT TRACKERS ════════════════════════════
export function recordReject(cb, type, orderId, events, time) {
  const nr = [...(cb.recentRejects || []), { time, type, orderId }];
  events.push({ evt: "cb:" + type, ts: time, s: orderId || "" });
  return { ...cb, recentRejects: nr.length > CFG.cbRejectWindow ? nr.slice(-CFG.cbRejectWindow) : nr };
}
export function recordApproval(cb) {
  const r = [...(cb.recentRejects || [])];
  if (r.length > 0) r.shift();
  return { ...cb, recentRejects: r };
}
export function recordSlipEvent(cb, slipBps, time) {
  const n = [...(cb.recentSlipEvents || []), { time, slipBps }];
  return { ...cb, recentSlipEvents: n.length > CFG.cbSlipWindow ? n.slice(-CFG.cbSlipWindow) : n };
}
export function recordPoorFill(cb, time) {
  const n = [...(cb.recentPoorFills || []), { time }];
  return { ...cb, recentPoorFills: n.length > CFG.cbPoorFillWindow ? n.slice(-CFG.cbPoorFillWindow) : n };
}
export function recordInvalidData(cb, marketId, time) {
  const n = [...(cb.recentInvalidData || []), { time, marketId }];
  return { ...cb, recentInvalidData: n.length > CFG.cbInvalidDataWindow ? n.slice(-CFG.cbInvalidDataWindow) : n };
}

// ═══════════════════════ EVENT LOG ════════════════════════════════════
/** Append-only structured log, bounded to 2000 entries (trimmed to 1500). */
export function appendEventLog(log, tick, time, type, data) {
  const entry = { tick, time, type, data };
  const newLog = [...log, entry];
  return newLog.length > 2000 ? newLog.slice(-1500) : newLog;
}

// ═══════════════════════ PERFORMANCE METRICS ══════════════════════════
/** Sharpe + win rate + avg slippage + exec quality + alpha contribution. */
export function computePerformanceMetrics(equityReturns, fills, metaPerf) {
  const n = equityReturns.length;
  let sharpe = 0;
  if (n >= 10) {
    const mean = equityReturns.reduce((s, v) => s + v, 0) / n;
    const std = Math.sqrt(equityReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) || 0.001;
    sharpe = +(mean / std * Math.sqrt(Math.min(n, 43200))).toFixed(2);
  }
  let wins = 0, total = 0;
  const fillsByOrder = {};
  for (const f of fills) { (fillsByOrder[f.orderId] || (fillsByOrder[f.orderId] = [])).push(f); }
  const slips = fills.filter(f => f.slipBps != null).map(f => f.slipBps);
  const avgSlipBps = slips.length > 0 ? +(slips.reduce((s, v) => s + v, 0) / slips.length).toFixed(1) : 0;
  const alphaContrib = {};
  for (const [src, perf] of Object.entries(metaPerf)) {
    if (perf.length === 0) { alphaContrib[src] = 0; continue; }
    alphaContrib[src] = +(perf.reduce((s, v) => s + v, 0)).toFixed(2);
    total += perf.length;
    wins += perf.filter(v => v > 0).length;
  }
  const winRate = total > 0 ? +(wins / total * 100).toFixed(1) : 0;
  const execQuality = avgSlipBps < 20 ? "good" : avgSlipBps < 40 ? "fair" : "poor";
  return { sharpe, winRate, avgSlipBps, execQuality, alphaContrib, totalFills: fills.length };
}

// ═══════════════════════ HISTORY PRUNING ══════════════════════════════
/** Seed → bounded transitive closure over parent/replacedBy chains. */
export function collectProtectedOrderIds(activeOrders, historyOrders) {
  const p = new Set(); const all = [...activeOrders, ...historyOrders];
  for (const o of activeOrders) { if (!TERMINAL.has(o.status)) p.add(o.id); }
  for (const o of all) {
    if (o.replacedBy) { p.add(o.id); p.add(o.replacedBy); }
    if (o.parentOrderId) { p.add(o.id); p.add(o.parentOrderId); }
  }
  for (let iter = 0; iter < 50; iter++) {
    let changed = false;
    for (const o of all) {
      if (p.has(o.id)) {
        if (o.parentOrderId && !p.has(o.parentOrderId)) { p.add(o.parentOrderId); changed = true; }
        if (o.replacedBy && !p.has(o.replacedBy)) { p.add(o.replacedBy); changed = true; }
      }
      if (o.parentOrderId && p.has(o.parentOrderId) && !p.has(o.id)) { p.add(o.id); changed = true; }
    }
    if (!changed) break;
  }
  return p;
}

/** Cap orderHistory length; always return a flat array. */
export function pruneOrderHistory(orderHistory, activeOrders) {
  if (!Array.isArray(orderHistory)) return [];
  if (orderHistory.length <= CFG.historyRetentionCap) return [...orderHistory];
  const prot = collectProtectedOrderIds(activeOrders, orderHistory);
  const protOrders = [], prunable = [];
  for (const o of orderHistory) {
    if (prot.has(o.id)) protOrders.push(o); else prunable.push(o);
  }
  const slots = Math.max(0, CFG.historyRetentionCap - protOrders.length);
  const budget = Math.max(Math.min(CFG.historyMinRetainTerminal, prunable.length), slots);
  return [...protOrders, ...prunable.slice(-Math.min(budget, prunable.length))];
}
