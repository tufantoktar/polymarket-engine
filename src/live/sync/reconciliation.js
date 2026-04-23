// ═══════════════════════════════════════════════════════════════════════
//  src/live/sync/reconciliation.js — periodic exchange ↔ local sync
// ═══════════════════════════════════════════════════════════════════════
//  Exchange is the source of truth. This module fetches remote positions
//  + open orders and corrects any drift in OrderStore / PositionStore.
//
//  Five drift cases handled (matching spec):
//    a) position present on exchange, missing locally    → restore
//    b) position present locally, absent on exchange     → correct (to qty=0)
//    c) partial fill differs from exchange state         → update filledSize + avg
//    d) external open order missing internally           → mark-for-review / restore
//    e) internal open order absent on exchange           → transition based on facts
//
//  Paper mode: short-circuits — there is no remote state.
//  All mutations go through the state modules (no bypass).
// ═══════════════════════════════════════════════════════════════════════

import { ORDER_STATES, isTerminalState } from "../state/orderStateMachine.js";

const EPS = 1e-6;

function approxEq(a, b, eps = EPS) {
  return Math.abs((a ?? 0) - (b ?? 0)) < eps;
}

/**
 * Run a single reconciliation pass.
 *
 * @param {Object} deps
 *   @param {Object} deps.client         PolymarketClient instance
 *   @param {Object} deps.wallet         Wallet instance (for getPositionBalance)
 *   @param {Object} deps.orderStore
 *   @param {Object} deps.positionStore
 *   @param {Object} deps.risk           LiveRiskEngine (to sync open-order set)
 *   @param {Object} deps.killSwitch     KillSwitch (to record API outcomes)
 *   @param {Object} deps.logger
 *   @param {Object} deps.config
 *   @param {string[]} [deps.tokenIds]   tokens we care about (for position sync)
 *
 * @returns {Promise<Object>}   summary — see spec
 */
export async function syncPositions(deps) {
  const { client, wallet, orderStore, positionStore, risk, killSwitch, logger, config } = deps;
  const tokenIds = deps.tokenIds || [];
  const summary = {
    timestamp: Date.now(),
    positionsRestored: 0,
    positionsCorrected: 0,
    ordersRestored: 0,
    ordersCorrected: 0,
    mismatches: [],
    errors: [],
  };

  // Paper mode: nothing to reconcile against
  if (config.mode !== "live") {
    logger.debug("reconcile:skip_paper_mode");
    summary.mode = "paper";
    return summary;
  }

  // ───────────────────────────────────────────────────────────────────
  //  1. Fetch remote open orders
  // ───────────────────────────────────────────────────────────────────
  let remoteOrders = [];
  try {
    remoteOrders = (await client.getOpenOrders()) || [];
    killSwitch?.recordApiSuccess();
  } catch (e) {
    killSwitch?.recordApiFailure({ op: "getOpenOrders" });
    summary.errors.push({ op: "getOpenOrders", message: e.message });
    logger.errorEvent("reconcile:getOpenOrders", e);
  }

  // Build lookup by exchange ID
  const remoteById = new Map();
  for (const ro of remoteOrders) {
    const id = ro.id || ro.orderID;
    if (id) remoteById.set(String(id), ro);
  }

  // ───────────────────────────────────────────────────────────────────
  //  2. Walk local open orders; reconcile each against remote
  // ───────────────────────────────────────────────────────────────────
  const localOpen = orderStore.listOpenOrders();
  const matchedRemoteIds = new Set();

  for (const lo of localOpen) {
    const extId = lo.externalOrderId;
    if (!extId) {
      // Order in flight with no external id yet — cannot reconcile; skip
      continue;
    }
    const remote = remoteById.get(String(extId));

    if (!remote) {
      // Case (e): we think it's open, exchange doesn't show it.
      // Two possibilities: it filled, or it was cancelled externally.
      // We try getOrderStatus for authoritative answer.
      try {
        const s = await client.getOrderStatus(extId);
        killSwitch?.recordApiSuccess();
        if (s && typeof s.status === "string") {
          const mapped = _mapRemoteStatus(s.status);
          if (mapped && !isTerminalState(lo.state)) {
            const filled = Number(s.size_matched ?? s.filledSize ?? 0);
            const avg = Number(s.avg_price ?? s.avgFillPrice ?? lo.avgFillPrice ?? 0) || null;
            const patch = { reason: `reconcile:remote=${s.status}` };
            if (filled > 0) { patch.filledSize = filled; if (avg) patch.avgFillPrice = avg; }
            const tr = orderStore.transition(lo.orderId, mapped, patch);
            if (tr.ok) {
              summary.ordersCorrected++;
              summary.mismatches.push({ type: "order_not_on_remote", orderId: lo.orderId, externalOrderId: extId, mappedTo: mapped });
              logger.decision("reconcile:order_corrected", { orderId: lo.orderId, externalOrderId: extId, from: lo.state, to: mapped, remoteStatus: s.status });
              risk?.untrackOrder(extId);
              killSwitch?.recordOrderTerminal(lo.orderId);
            }
          }
        }
      } catch (e) {
        killSwitch?.recordApiFailure({ op: "getOrderStatus", extId });
        summary.errors.push({ op: "getOrderStatus", extId, message: e.message });
      }
      continue;
    }

    // Remote exists — compare state
    matchedRemoteIds.add(String(extId));
    const remoteFilled = Number(remote.size_matched ?? remote.filledSize ?? 0);

    // Case (c): partial fill drift
    if (!approxEq(remoteFilled, lo.filledSize)) {
      if (remoteFilled > lo.filledSize + EPS) {
        const isFull = remoteFilled >= lo.size - EPS;
        const next = isFull ? ORDER_STATES.FILLED : ORDER_STATES.PARTIAL_FILL;
        const remoteAvg = Number(remote.avg_price ?? remote.avgFillPrice ?? lo.avgFillPrice ?? 0) || null;
        const tr = orderStore.transition(lo.orderId, next, {
          filledSize: remoteFilled,
          avgFillPrice: remoteAvg,
          reason: "reconcile:fill_drift",
        });
        if (tr.ok) {
          summary.ordersCorrected++;
          summary.mismatches.push({
            type: "fill_drift",
            orderId: lo.orderId,
            externalOrderId: extId,
            localFilled: lo.filledSize,
            remoteFilled,
          });
          logger.decision("reconcile:fill_drift_corrected", {
            orderId: lo.orderId, externalOrderId: extId,
            localFilled: lo.filledSize, remoteFilled, state: next,
          });
          if (isFull) {
            risk?.untrackOrder(extId);
            killSwitch?.recordOrderTerminal(lo.orderId);
          } else {
            killSwitch?.recordOrderProgress(lo.orderId);
          }
        }
      }
      // If localFilled > remoteFilled, local is optimistic. Rare in
      // live mode (fills arrive via poll). We log the mismatch but
      // don't unwind — that would require emitting negative fills,
      // which is outside reconciliation scope.
      else {
        summary.mismatches.push({
          type: "local_ahead_of_remote",
          orderId: lo.orderId, externalOrderId: extId,
          localFilled: lo.filledSize, remoteFilled,
        });
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────
  //  3. Remote orders with no local counterpart (case d)
  // ───────────────────────────────────────────────────────────────────
  for (const [extId, remote] of remoteById) {
    if (matchedRemoteIds.has(extId)) continue;
    // Already known under a different state? (e.g. manual orders placed
    // outside the bot, or pre-restart orders restored by startupRecovery)
    const existing = orderStore.findByExternalOrderId(extId);
    if (existing) continue;

    summary.mismatches.push({
      type: "remote_order_not_local",
      externalOrderId: extId,
      status: remote.status,
    });
    summary.ordersRestored++;
    logger.decision("reconcile:remote_order_not_local", { externalOrderId: extId, status: remote.status });
    // We don't auto-register these — policy decision deferred to
    // startupRecovery, which has full context. At runtime this is
    // usually a manual order or stale cache; surface + move on.
  }

  // ───────────────────────────────────────────────────────────────────
  //  4. Position reconciliation — exchange is truth
  // ───────────────────────────────────────────────────────────────────
  const positionTokens = new Set([
    ...tokenIds,
    ...positionStore.list().map(p => p.tokenId),
  ]);

  for (const tid of positionTokens) {
    let remoteQty = null;
    try {
      remoteQty = await wallet.getPositionBalance(tid);
      killSwitch?.recordApiSuccess();
    } catch (e) {
      killSwitch?.recordApiFailure({ op: "getPositionBalance", tid });
      summary.errors.push({ op: "getPositionBalance", tokenId: tid, message: e.message });
      continue;
    }
    const local = positionStore.get(tid);
    if (approxEq(remoteQty, local.qty)) continue;

    // Drift: overwrite. Cost basis isn't preserved by exchange (we
    // only see qty), so we keep the local avgEntryPrice as a best-
    // effort estimate when local had a position. If qty→0, zero the avg.
    const nextAvg = remoteQty === 0 ? 0 : local.avgEntryPrice;
    positionStore.set(tid, {
      ...local, qty: remoteQty, avgEntryPrice: nextAvg,
    });

    if (local.qty === 0 && remoteQty !== 0) {
      summary.positionsRestored++;
      summary.mismatches.push({ type: "position_not_local", tokenId: tid, remoteQty });
      logger.decision("reconcile:position_restored", { tokenId: tid, remoteQty });
    } else if (local.qty !== 0 && remoteQty === 0) {
      summary.positionsCorrected++;
      summary.mismatches.push({ type: "position_not_remote", tokenId: tid, localQty: local.qty });
      logger.decision("reconcile:position_zeroed", { tokenId: tid, localQty: local.qty });
    } else {
      summary.positionsCorrected++;
      summary.mismatches.push({ type: "position_qty_drift", tokenId: tid, localQty: local.qty, remoteQty });
      logger.decision("reconcile:position_drift_corrected", { tokenId: tid, localQty: local.qty, remoteQty });
    }
  }

  // ───────────────────────────────────────────────────────────────────
  //  5. Sync risk-engine open-order set to remote truth
  // ───────────────────────────────────────────────────────────────────
  risk?.syncOpenOrders([...remoteById.keys()]);

  logger.decision("reconcile:summary", summary);
  return summary;
}

/** Normalize exchange status strings into our FSM vocabulary. */
function _mapRemoteStatus(status) {
  const s = String(status).toLowerCase();
  if (s === "filled" || s === "matched") return ORDER_STATES.FILLED;
  if (s === "cancelled" || s === "canceled" || s === "expired") return ORDER_STATES.CANCELLED;
  if (s === "failed" || s === "rejected") return ORDER_STATES.FAILED;
  if (s === "live" || s === "open" || s === "resting") return null;  // still active → no transition
  if (s === "matched_partially" || s === "partially_filled") return ORDER_STATES.PARTIAL_FILL;
  return null;
}
