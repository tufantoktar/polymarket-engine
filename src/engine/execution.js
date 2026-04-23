// ═══════════════════════════════════════════════════════════════════════
//  engine/execution.js — order lifecycle, FSM, fill matching
// ═══════════════════════════════════════════════════════════════════════
//  Pure functions. Input → output. No React, no state mutations outside
//  the returned value.
//
//  Exports:
//   - TERMINAL, TRANSITIONS    (FSM constants, read-only sets)
//   - canTransition            (FSM guard)
//   - makeChildId, makeOrderId (deterministic id builders)
//   - buildChildren            (TWAP/aggressive/patient child slicing)
//   - computeAdaptiveLimit     (LOB-aware limit price)
//   - createOrder              (recommendation + risk verdict → order)
//   - checkSlippage            (bps threshold check)
//   - advanceOrderFills        (LOB matching + FSM advance)
//   - resolvePartialFill       (RETRY / REPLACE / UNWIND / CANCEL)

import { cl, r4 } from "../utils/math.js";
import { CFG } from "../config/config.js";
import { matchOrderAgainstLOB, applyAdverseSelection } from "./market.js";

// Terminal states are immutable — no transitions out.
export const TERMINAL = new Set(["FILLED", "CANCELLED", "REJECTED", "REPLACED"]);

export const TRANSITIONS = {
  NEW: new Set(["ACCEPTED", "REJECTED"]),
  ACCEPTED: new Set(["PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED"]),
  PARTIALLY_FILLED: new Set(["PARTIALLY_FILLED", "FILLED", "CANCELLED", "REPLACED"]),
  FILLED: new Set(),
  CANCELLED: new Set(),
  REJECTED: new Set(),
  REPLACED: new Set(),
};

/** FSM guard: terminal states always return false. */
export function canTransition(from, to) {
  if (TERMINAL.has(from)) return false;
  return TRANSITIONS[from]?.has(to) || false;
}

/** Deterministic child id. */
export function makeChildId(orderId, seq, gen) {
  return orderId + "_c" + seq + "_g" + gen;
}

/** Deterministic order id. */
export function makeOrderId(prefix, cid, time, seq) {
  return prefix + "_" + cid + "_" + time + "_s" + seq;
}

/** Slice total size into children according to execution strategy. */
export function buildChildren(orderId, totalSz, limitPx, strategy, gen) {
  let sliceSize;
  if (strategy === "twap") sliceSize = Math.ceil(totalSz / CFG.twapSlices);
  else if (strategy === "aggressive") sliceSize = totalSz;
  else sliceSize = Math.min(200, totalSz);
  const n = Math.ceil(totalSz / sliceSize);
  const children = []; let rem = totalSz;
  for (let i = 0; i < n; i++) {
    const sz = Math.min(rem, sliceSize);
    children.push({ id: makeChildId(orderId, i, gen), sz, lim: limitPx, fp: null, st: "NEW", scheduleIdx: i });
    rem -= sz;
  }
  return children;
}

/**
 * Adaptive limit price based on LOB state + urgency.
 *   immediate → cross the spread
 *   patient   → sit 30% inside the spread
 *   passive   → sit at mid
 */
export function computeAdaptiveLimit(lob, side, urgency) {
  if (urgency === "immediate") {
    return side === "YES" ? lob.bestAsk : lob.bestBid;
  } else if (urgency === "patient") {
    return side === "YES" ? r4(lob.bestBid + lob.spread * 0.3) : r4(lob.bestAsk - lob.spread * 0.3);
  }
  return lob.midPrice;
}

/** Build a new order from a recommendation + risk verdict. Returns null if verdict not ok. */
export function createOrder(rec, verdict, mkts, lobs, time, rng, seq) {
  if (!verdict.ok) return null;
  const m = mkts[rec.cid]; if (!m) return null;
  const lob = lobs[rec.cid];
  const side = rec.dir === "BUY_YES" ? "YES" : "NO";
  const lim = lob ? computeAdaptiveLimit(lob, side, rec.urg) : r4(cl(side === "YES" ? m.yes : 1 - m.yes, 0.01, 0.99));
  let strat = "patient";
  if (verdict.sz < 500 && rec.urg === "immediate") strat = "aggressive";
  else if (verdict.sz > 2000) strat = "twap";
  else if (verdict.sz > 500) strat = "vwap";
  const id = makeOrderId("ord", rec.cid, time, seq);
  return {
    id, time, cid: rec.cid, side, dir: rec.dir,
    parentSz: verdict.sz, lim, strat,
    children: buildChildren(id, verdict.sz, lim, strat, 0),
    status: "NEW", totalFilled: 0, avgFP: null,
    ce: rec.ce, attr: rec.attr, riskCh: verdict.ch, urg: rec.urg,
    fillRate: 0, slipBps: null, partialAction: null,
    retryBudget: CFG.partialRetryBudget, retryGen: 0,
    replacedBy: null, parentOrderId: null,
  };
}

/** Compute slippage in bps and flag if it exceeds config threshold. */
export function checkSlippage(fillPx, limitPx, midPx) {
  const slipBps = +(Math.abs(fillPx - limitPx) / (midPx || 0.5) * 10000).toFixed(2);
  return { slipBps, exceeded: slipBps > CFG.maxSlipBps };
}

/**
 * Advance an order one tick: match against LOB, update children, evolve FSM.
 * Returns new order + new fills + slip-reject count + updated LOB snapshot.
 */
export function advanceOrderFills(order, rng, mkts, lobs, tickTime, existingFillKeys) {
  if (TERMINAL.has(order.status)) return { order, newFills: [], childSlipRejects: 0, updatedLobs: {} };
  const o = { ...order, children: order.children.map(c => ({ ...c })) };
  if (o.status === "NEW") {
    if (!canTransition("NEW", "ACCEPTED")) return { order: o, newFills: [], childSlipRejects: 0, updatedLobs: {} };
    o.status = "ACCEPTED";
  }
  const mkt = mkts[o.cid];
  let lob = lobs[o.cid]
    ? { ...lobs[o.cid], bids: lobs[o.cid].bids.map(l => ({ ...l, orders: [...l.orders] })), asks: lobs[o.cid].asks.map(l => ({ ...l, orders: [...l.orders] })) }
    : null;
  const mid = lob ? lob.midPrice : (mkt ? (o.side === "YES" ? mkt.yes : 1 - mkt.yes) : o.lim);
  let filled = 0, cost = 0, childSlipRejects = 0;
  const newFills = [];

  for (const ch of o.children) {
    if (ch.st === "FILLED") { filled += ch.sz; cost += ch.fp * ch.sz; continue; }
    if (ch.st === "CANCELLED" || ch.st === "REJECTED") continue;
    if (ch.st === "NEW") ch.st = "ACCEPTED";
    // Phase 5: cancel/replace if limit drifted too far from current mid
    if (lob) {
      const limitDrift = Math.abs(ch.lim - lob.midPrice) / (lob.midPrice || 0.5) * 10000;
      if (limitDrift > CFG.cancelReplaceThresholdBps && ch.st === "ACCEPTED") {
        ch.lim = computeAdaptiveLimit(lob, o.side, o.urg);
      }
    }
    // Phase 1: LOB matching (no random fills)
    if (lob) {
      const matchSide = o.side === "YES" ? "buy" : "sell";
      const result = matchOrderAgainstLOB(lob, matchSide, ch.sz, ch.lim, ch.id, tickTime);
      if (result.totalFilled > 0) {
        const fillPx = result.avgPx;
        const slip = checkSlippage(fillPx, ch.lim, mid);
        if (slip.exceeded) { ch.st = "REJECTED"; childSlipRejects++; lob = result.updatedLob; continue; }
        const fillKey = "fill_" + o.id + "_" + ch.id;
        if (existingFillKeys[fillKey]) {
          ch.st = "FILLED"; ch.fp = fillPx;
          filled += result.totalFilled; cost += fillPx * result.totalFilled;
          lob = result.updatedLob; continue;
        }
        ch.fp = fillPx; ch.st = result.totalFilled >= ch.sz ? "FILLED" : "ACCEPTED";
        if (ch.st === "FILLED") { filled += ch.sz; cost += fillPx * ch.sz; }
        else { filled += result.totalFilled; cost += fillPx * result.totalFilled; ch.sz -= result.totalFilled; }
        newFills.push({ key: fillKey, orderId: o.id, cid: o.cid, side: o.side, qty: result.totalFilled, px: fillPx, time: tickTime, slipBps: slip.slipBps, attr: o.attr || {} });
        // Phase 2: adverse selection after aggressive fill
        if (o.urg === "immediate") lob = { ...result.updatedLob, midPrice: applyAdverseSelection(fillPx, result.updatedLob.midPrice, matchSide) };
        else lob = result.updatedLob;
      }
      // If no fill, order stays at its price level (queue position preserved)
    } else {
      // Fallback: basic fill simulation for markets without LOB
      const fr = o.strat === "aggressive" ? 0.92 : o.strat === "twap" ? 0.8 : 0.6;
      if (rng() < fr) {
        const rawFP = r4(ch.lim + (rng() - 0.5) * 0.004);
        const slip = checkSlippage(rawFP, ch.lim, mid);
        if (slip.exceeded) { ch.st = "REJECTED"; childSlipRejects++; continue; }
        const fillKey = "fill_" + o.id + "_" + ch.id;
        if (existingFillKeys[fillKey]) { ch.st = "FILLED"; ch.fp = rawFP; filled += ch.sz; cost += rawFP * ch.sz; continue; }
        ch.fp = rawFP; ch.st = "FILLED"; filled += ch.sz; cost += rawFP * ch.sz;
        newFills.push({ key: fillKey, orderId: o.id, cid: o.cid, side: o.side, qty: ch.sz, px: rawFP, time: tickTime, slipBps: slip.slipBps, attr: o.attr || {} });
      }
    }
  }

  o.totalFilled = filled;
  o.avgFP = filled > 0 ? +(cost / filled).toFixed(4) : null;
  o.fillRate = +(filled / o.parentSz).toFixed(2);
  if (newFills.length) o.slipBps = +(newFills.reduce((s, f) => s + f.slipBps, 0) / newFills.length).toFixed(2);
  if (filled >= o.parentSz) { if (canTransition(o.status, "FILLED")) o.status = "FILLED"; }
  else if (filled > 0 && o.status === "ACCEPTED") { if (canTransition(o.status, "PARTIALLY_FILLED")) o.status = "PARTIALLY_FILLED"; }
  if (!TERMINAL.has(o.status)) {
    const pending = o.children.filter(c => c.st === "NEW" || c.st === "ACCEPTED");
    if (pending.length === 0 && filled < o.parentSz && filled > 0) { if (canTransition(o.status, "PARTIALLY_FILLED")) o.status = "PARTIALLY_FILLED"; }
    if (pending.length === 0 && filled === 0) { if (canTransition(o.status, "REJECTED")) o.status = "REJECTED"; }
  }
  const updatedLobs = lob ? { [o.cid]: lob } : {};
  return { order: o, newFills, childSlipRejects, updatedLobs };
}

/**
 * Resolve a partially-filled order. Deterministic outcomes:
 *   - remaining < partialMinQty → CANCEL
 *   - drift <= threshold && retryBudget > 0 → RETRY (same limit, new gen)
 *   - drift ∈ (threshold, 3x threshold] && budget > 0 → REPLACE (new order)
 *   - drift > threshold OR budget <= 0 → UNWIND (aggressive close)
 *   - fallback → CANCEL
 */
export function resolvePartialFill(order, mkts, lobs, time, rng, seqRef) {
  if (order.status !== "PARTIALLY_FILLED") return { order, spawned: [] };
  const o = { ...order, children: order.children.map(c => ({ ...c })) };
  const mkt = mkts[o.cid]; const remaining = o.parentSz - o.totalFilled;
  const lob = lobs[o.cid];
  const currentMid = lob ? lob.midPrice : (mkt ? (o.side === "YES" ? mkt.yes : 1 - mkt.yes) : o.lim);
  const drift = Math.abs(currentMid - o.lim); const spawned = [];

  if (remaining < CFG.partialMinQty) {
    o.partialAction = { action: "CANCEL", reason: "remaining " + remaining + " < minQty" };
    for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
    if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED";
    return { order: o, spawned };
  }
  if (drift <= CFG.partialDriftThreshold && o.retryBudget > 0) {
    o.retryBudget--; o.retryGen = (o.retryGen || 0) + 1;
    o.partialAction = { action: "RETRY", reason: "gen=" + o.retryGen + ", budget=" + o.retryBudget };
    for (const ch of o.children) { if (ch.st === "ACCEPTED" || ch.st === "REJECTED") ch.st = "CANCELLED"; }
    o.children = [...o.children, ...buildChildren(o.id, remaining, o.lim, o.strat, o.retryGen)];
    return { order: o, spawned };
  }
  if (drift > CFG.partialDriftThreshold && drift <= CFG.partialDriftThreshold * 3 && o.retryBudget > 0) {
    o.partialAction = { action: "REPLACE", reason: "drift=" + (drift * 100).toFixed(1) + "%" };
    for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
    if (canTransition(o.status, "REPLACED")) {
      o.status = "REPLACED"; const newLim = r4(cl(currentMid, 0.01, 0.99));
      const replId = makeOrderId("ord_repl", o.cid, time, seqRef.val++);
      spawned.push({
        id: replId, time, cid: o.cid, side: o.side, dir: o.dir,
        parentSz: remaining, lim: newLim, strat: o.strat,
        children: buildChildren(replId, remaining, newLim, o.strat, 0),
        status: "NEW", totalFilled: 0, avgFP: null,
        ce: o.ce, attr: o.attr, riskCh: o.riskCh, urg: o.urg,
        fillRate: 0, slipBps: null, partialAction: null,
        retryBudget: Math.max(0, o.retryBudget - 1), retryGen: 0,
        replacedBy: null, parentOrderId: o.id,
      });
      o.replacedBy = replId;
    }
    return { order: o, spawned };
  }
  if (drift > CFG.partialDriftThreshold || o.retryBudget <= 0) {
    o.partialAction = { action: "UNWIND", reason: "drift=" + (drift * 100).toFixed(1) + "%, qty " + o.totalFilled };
    for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
    if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED";
    if (o.totalFilled > 0) {
      const uwDir = o.dir === "BUY_YES" ? "BUY_NO" : "BUY_YES";
      const uwSide = uwDir === "BUY_YES" ? "YES" : "NO";
      const uwLim = r4(cl(currentMid, 0.01, 0.99));
      const uwId = makeOrderId("ord_unwind", o.cid, time, seqRef.val++);
      spawned.push({
        id: uwId, time, cid: o.cid, side: uwSide, dir: uwDir,
        parentSz: o.totalFilled, lim: uwLim, strat: "aggressive",
        children: buildChildren(uwId, o.totalFilled, uwLim, "aggressive", 0),
        status: "NEW", totalFilled: 0, avgFP: null,
        ce: o.ce, attr: o.attr, riskCh: [], urg: "immediate",
        fillRate: 0, slipBps: null, partialAction: null,
        retryBudget: 0, retryGen: 0,
        replacedBy: null, parentOrderId: o.id,
      });
    }
    return { order: o, spawned };
  }
  o.partialAction = { action: "CANCEL", reason: "fallback" };
  for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
  if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED";
  return { order: o, spawned };
}
