// ═══════════════════════════════════════════════════════════════════════
//  engine/portfolio.js — fills → positions, PnL metrics, attribution
// ═══════════════════════════════════════════════════════════════════════
//  Pure functions. Fill dedup is idempotent (fillKeys ledger).
//
//  Exports:
//   - applyFills                (apply new fills, emit attrEvents on close)
//   - rebuildPositionsFromFills (reconstruct positions from ledger)
//   - computeMetrics            (equity + dd + exposure snapshot)
//   - applyAttributionEvents    (update metaPerf from attrEvents)

import { r4 } from "../utils/math.js";
import { CFG } from "../config/config.js";
import { calcExposure } from "./risk.js";

/**
 * Apply new fills to positions. Idempotent: duplicate fill keys never reapply.
 * Emits attribution events (rpnl × attr) only for the CLOSING portion of a fill.
 * The opening portion of a cross-fill produces no rPnL attribution.
 */
export function applyFills(positions, fills, fillKeys, newFills) {
  let pos = { ...positions };
  let fs = [...fills];
  let fk = { ...fillKeys };
  const attrEvents = [];

  for (const f of newFills) {
    if (fk[f.key]) continue;
    fk[f.key] = true;
    fs.push(f);
    const mid = f.cid;
    const p = pos[mid] ? { ...pos[mid] } : { yesQty: 0, noQty: 0, yesAvgPx: 0, noAvgPx: 0, realizedPnl: 0 };

    if (f.side === "YES") {
      if (p.noQty > 0) {
        const oq = Math.min(f.qty, p.noQty);
        const ep = 1 - f.px;
        const fillRpnl = +(oq * (ep - p.noAvgPx)).toFixed(4);
        p.realizedPnl = +(p.realizedPnl + fillRpnl).toFixed(4);
        if (Math.abs(fillRpnl) > 0.0001 && f.attr && Object.keys(f.attr).length > 0) {
          attrEvents.push({ rpnl: fillRpnl, attr: f.attr });
        }
        p.noQty -= oq; if (p.noQty <= 0) { p.noQty = 0; p.noAvgPx = 0; }
        const aq = f.qty - oq;
        if (aq > 0) { const t = p.yesQty + aq; p.yesAvgPx = t > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * aq) / t) : 0; p.yesQty = t; }
      } else {
        const t = p.yesQty + f.qty;
        p.yesAvgPx = t > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * f.qty) / t) : 0;
        p.yesQty = t;
      }
    } else {
      if (p.yesQty > 0) {
        const oq = Math.min(f.qty, p.yesQty);
        const ep = 1 - f.px;
        const fillRpnl = +(oq * (ep - p.yesAvgPx)).toFixed(4);
        p.realizedPnl = +(p.realizedPnl + fillRpnl).toFixed(4);
        if (Math.abs(fillRpnl) > 0.0001 && f.attr && Object.keys(f.attr).length > 0) {
          attrEvents.push({ rpnl: fillRpnl, attr: f.attr });
        }
        p.yesQty -= oq; if (p.yesQty <= 0) { p.yesQty = 0; p.yesAvgPx = 0; }
        const aq = f.qty - oq;
        if (aq > 0) { const t = p.noQty + aq; p.noAvgPx = t > 0 ? r4((p.noAvgPx * p.noQty + f.px * aq) / t) : 0; p.noQty = t; }
      } else {
        const t = p.noQty + f.qty;
        p.noAvgPx = t > 0 ? r4((p.noAvgPx * p.noQty + f.px * f.qty) / t) : 0;
        p.noQty = t;
      }
    }
    pos = { ...pos, [mid]: p };
  }

  return { positions: pos, fills: fs, fillKeys: fk, attrEvents };
}

/**
 * Rebuild positions from the fill ledger. Used by reconciliation to detect
 * and correct drift between `positions` and the authoritative `fills`.
 */
export function rebuildPositionsFromFills(fills) {
  const pos = {};
  for (const f of fills) {
    const mid = f.cid;
    const p = pos[mid] || { yesQty: 0, noQty: 0, yesAvgPx: 0, noAvgPx: 0, realizedPnl: 0 };
    if (f.side === "YES") {
      if (p.noQty > 0) {
        const oq = Math.min(f.qty, p.noQty);
        p.realizedPnl = +(p.realizedPnl + oq * ((1 - f.px) - p.noAvgPx)).toFixed(4);
        p.noQty -= oq; if (p.noQty <= 0) { p.noQty = 0; p.noAvgPx = 0; }
        const aq = f.qty - oq;
        if (aq > 0) { const t = p.yesQty + aq; p.yesAvgPx = t > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * aq) / t) : 0; p.yesQty = t; }
      } else {
        const t = p.yesQty + f.qty;
        p.yesAvgPx = t > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * f.qty) / t) : 0;
        p.yesQty = t;
      }
    } else {
      if (p.yesQty > 0) {
        const oq = Math.min(f.qty, p.yesQty);
        p.realizedPnl = +(p.realizedPnl + oq * ((1 - f.px) - p.yesAvgPx)).toFixed(4);
        p.yesQty -= oq; if (p.yesQty <= 0) { p.yesQty = 0; p.yesAvgPx = 0; }
        const aq = f.qty - oq;
        if (aq > 0) { const t = p.noQty + aq; p.noAvgPx = t > 0 ? r4((p.noAvgPx * p.noQty + f.px * aq) / t) : 0; p.noQty = t; }
      } else {
        const t = p.noQty + f.qty;
        p.noAvgPx = t > 0 ? r4((p.noAvgPx * p.noQty + f.px * f.qty) / t) : 0;
        p.noQty = t;
      }
    }
    pos[mid] = p;
  }
  return pos;
}

/** Equity / DD / exposure snapshot. Uses mark-to-market via current YES prices. */
export function computeMetrics(positions, markets, eqCurve, peakEq) {
  let rPnl = 0, uPnl = 0;
  const exp = calcExposure(positions, markets);
  for (const [mid, pos] of Object.entries(positions)) {
    const m = markets[mid]; if (!m) continue;
    rPnl += pos.realizedPnl;
    uPnl += pos.yesQty * (m.yes - pos.yesAvgPx) + pos.noQty * ((1 - m.yes) - pos.noAvgPx);
  }
  const totalPnl = +(rPnl + uPnl).toFixed(2);
  const equity = +(CFG.initialEquity + totalPnl).toFixed(2);
  const pk = Math.max(peakEq, equity);
  const dd = pk > 0 ? +((pk - equity) / pk).toFixed(4) : 0;
  const curve = [...eqCurve, equity];
  if (curve.length > 200) curve.splice(0, curve.length - 200);
  return {
    realizedPnl: +rPnl.toFixed(2), unrealizedPnl: +uPnl.toFixed(2),
    totalPnl, equity, peakEquity: pk, currentDD: dd,
    equityCurve: curve, grossExposure: exp.gross, netExposure: exp.net,
    catExposure: exp.catNotional,
  };
}

/**
 * Apply fill-level attribution events into metaPerf buffers.
 * Defensive: rejects non-finite rpnl, null/array/invalid attr, non-numeric pct.
 * Caps each source buffer at 50 entries.
 */
export function applyAttributionEvents(metaPerf, attrEvents) {
  if (!attrEvents || attrEvents.length === 0) return metaPerf;
  const result = {
    nlp: [...metaPerf.nlp],
    momentum: [...metaPerf.momentum],
    arb: [...metaPerf.arb],
  };
  for (const evt of attrEvents) {
    if (!evt || typeof evt.rpnl !== "number" || !Number.isFinite(evt.rpnl)) continue;
    if (Math.abs(evt.rpnl) < 0.0001) continue;
    const attr = evt.attr;
    if (!attr || typeof attr !== "object" || Array.isArray(attr)) continue;
    for (const [src, pct] of Object.entries(attr)) {
      const buf = result[src]; if (!buf) continue;
      if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
      buf.push(+(evt.rpnl * pct / 100).toFixed(6));
      if (buf.length > 50) buf.shift();
    }
  }
  return result;
}
