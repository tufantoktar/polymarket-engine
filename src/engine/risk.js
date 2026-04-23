// ═══════════════════════════════════════════════════════════════════════
//  engine/risk.js — exposure computation and pre-trade risk validation
// ═══════════════════════════════════════════════════════════════════════
//  Pure functions. Input snapshot → verdict.
//
//  Exports:
//   - calcExposure      (gross/net/per-category notional + qty)
//   - preTradeRisk      (8-check pipeline, returns {ok, sz, ch})

import { CFG } from "../config/config.js";
import { checkCorrelatedExposure } from "./market.js";

/**
 * Notional-only exposure model. No double-counting.
 * Returns gross/net notional + per-category maps.
 */
export function calcExposure(positions, markets) {
  let gross = 0, net = 0;
  const catNotional = {}, catQty = {};
  for (const [mid, pos] of Object.entries(positions)) {
    const m = markets[mid]; if (!m) continue;
    const yN = pos.yesQty * m.yes, nN = pos.noQty * (1 - m.yes);
    gross += yN + nN;
    net += Math.abs(yN - nN);
    catNotional[m.cat] = (catNotional[m.cat] || 0) + yN + nN;
    catQty[m.cat] = (catQty[m.cat] || 0) + pos.yesQty + pos.noQty;
  }
  return { gross: +gross.toFixed(2), net: +net.toFixed(2), catNotional, catQty };
}

/**
 * Pre-trade risk pipeline. Each check either passes, adjusts allowedQty
 * downward, or blocks. Explicit variable names keep qty vs notional distinct.
 *
 * Check order:
 *   1. Circuit breaker state
 *   2. Per-market position qty
 *   3. Gross exposure notional
 *   4. Drawdown scaler
 *   5. Per-category position qty
 *   6. Liquidity ratio (ADV / requestedQty)
 *   7. Signal quality
 *   8. Market quarantine (invalid data)
 *   9. (Phase 4) Correlated exposure
 *
 * Returns {ok, sz, ch}. ch is an array of check records for UI/audit.
 */
export function preTradeRisk(rec, snap) {
  const { positions, markets, cb, currentDD, grossExposure } = snap;
  const checks = []; let approved = true; let allowedQty = rec.sz;
  const mkt = markets[rec.cid];
  const sidePrice = mkt ? (rec.dir === "BUY_YES" ? mkt.yes : 1 - mkt.yes) : 0.5;

  // 1. Circuit breaker
  if (cb.state === "open") {
    checks.push({ n: "CB", s: "blocked", d: cb.reason }); approved = false;
  } else if (cb.state === "half_open") {
    const hq = sidePrice > 0 ? Math.floor(CFG.cbHalfOpenMaxNotional / sidePrice) : 0;
    if (allowedQty > hq) { allowedQty = hq; checks.push({ n: "CB", s: "adjusted", d: "half_open→qty " + hq }); }
    else checks.push({ n: "CB", s: "adjusted", d: "half_open probe" });
    if (allowedQty <= 0) approved = false;
  } else {
    checks.push({ n: "CB", s: "pass", d: "closed" });
  }

  // 2. Per-market position qty
  const pos = positions[rec.cid] || { yesQty: 0, noQty: 0 };
  const existingQty = pos.yesQty + pos.noQty;
  if (existingQty + allowedQty > CFG.maxPos) {
    allowedQty = Math.max(0, CFG.maxPos - existingQty);
    checks.push({ n: "PosQty", s: allowedQty > 0 ? "adjusted" : "blocked", d: "qty:" + existingQty + "+" + allowedQty + "/" + CFG.maxPos });
    if (!allowedQty) approved = false;
  } else {
    checks.push({ n: "PosQty", s: "pass", d: "qty:" + (existingQty + allowedQty) + "/" + CFG.maxPos });
  }

  // 3. Gross exposure notional
  const additionalNotional = +(allowedQty * sidePrice).toFixed(2);
  const remainingN = Math.max(0, CFG.maxExpNotional - grossExposure);
  if (additionalNotional > remainingN) {
    const maxQ = sidePrice > 0 ? Math.floor(remainingN / sidePrice) : 0;
    allowedQty = Math.min(allowedQty, maxQ);
    checks.push({ n: "ExpN", s: allowedQty > 0 ? "adjusted" : "blocked", d: "notional:" + grossExposure + "+" + (+(allowedQty * sidePrice).toFixed(0)) + "/" + CFG.maxExpNotional });
    if (!allowedQty) approved = false;
  } else {
    checks.push({ n: "ExpN", s: "pass", d: "notional:" + grossExposure + "+" + additionalNotional + "/" + CFG.maxExpNotional });
  }

  // 4. Drawdown scaler
  const ddScale = currentDD >= CFG.maxDD ? 0 : currentDD > CFG.softDD ? 1 - Math.pow(currentDD / CFG.maxDD, 1.5) : 1;
  if (ddScale < 1) {
    allowedQty = Math.floor(allowedQty * ddScale);
    checks.push({ n: "DD", s: ddScale > 0 ? "adjusted" : "blocked", d: "s=" + ddScale.toFixed(2) });
    if (!allowedQty) approved = false;
  } else {
    checks.push({ n: "DD", s: "pass", d: (currentDD * 100).toFixed(1) + "%" });
  }

  // 5. Per-category position qty
  let existingCatQty = 0;
  if (mkt) {
    for (const [om, op] of Object.entries(positions)) {
      const omk = markets[om];
      if (omk && omk.cat === mkt.cat) existingCatQty += op.yesQty + op.noQty;
    }
  }
  if (existingCatQty + allowedQty > CFG.maxCatQty) {
    allowedQty = Math.max(0, CFG.maxCatQty - existingCatQty);
    checks.push({ n: "CatQty", s: allowedQty > 0 ? "adjusted" : "blocked", d: mkt?.cat + ":qty=" + existingCatQty + "+" + allowedQty + "/" + CFG.maxCatQty });
    if (!allowedQty) approved = false;
  } else {
    checks.push({ n: "CatQty", s: "pass", d: mkt?.cat + ":qty=" + (existingCatQty + allowedQty) + "/" + CFG.maxCatQty });
  }

  // 6. Liquidity ratio
  const lr = mkt && allowedQty > 0 ? mkt.adv / allowedQty : 999;
  if (lr < CFG.minLiqRatio) {
    checks.push({ n: "Liq", s: "blocked", d: lr.toFixed(1) }); approved = false;
  } else {
    checks.push({ n: "Liq", s: "pass", d: lr.toFixed(1) });
  }

  // 7. Signal quality
  if ((rec.aq || 0) < CFG.minSigQuality) {
    checks.push({ n: "Qual", s: "blocked", d: "" + rec.aq }); approved = false;
  } else {
    checks.push({ n: "Qual", s: "pass", d: "" + rec.aq });
  }

  // 8. Market quarantine
  if (snap.quarantined[rec.cid]) {
    checks.push({ n: "MktVal", s: "blocked", d: snap.quarantined[rec.cid].join(",") }); approved = false;
  } else {
    checks.push({ n: "MktVal", s: "pass", d: "valid" });
  }

  // 9. Phase 4: correlated exposure
  if (snap.corrMatrix && Object.keys(snap.corrMatrix).length > 0) {
    const ce = checkCorrelatedExposure(positions, markets, snap.corrMatrix);
    if (!ce.ok) { checks.push({ n: "CorrExp", s: "blocked", d: "ratio=" + ce.ratio }); approved = false; }
    else checks.push({ n: "CorrExp", s: "pass", d: "ratio=" + ce.ratio });
  }

  return { ok: approved && allowedQty >= 15, sz: allowedQty, ch: checks };
}
