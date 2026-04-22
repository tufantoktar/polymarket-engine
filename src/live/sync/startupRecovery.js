// ═══════════════════════════════════════════════════════════════════════
//  src/live/sync/startupRecovery.js — restore state on boot
// ═══════════════════════════════════════════════════════════════════════
//  When the bot restarts, it must not:
//    - forget that it had live open orders
//    - place duplicate orders for signals that were already acted on
//    - report a clean slate for positions that already exist on-chain
//
//  Recovery is a one-shot, synchronous-looking async procedure. The
//  event loop MUST await it before starting live trading. If recovery
//  fails hard, we surface the error and expect the caller to decide
//  whether to abort or continue in a degraded mode.
//
//  Strategy: for each remote open order, synthesize a best-effort
//  internal order record in ORDER_PLACED state, wired with a
//  deterministic signalKey derived from the remote metadata so the
//  SignalDeduper will reject a fresh signal for the same opportunity.
// ═══════════════════════════════════════════════════════════════════════

import { ORDER_STATES } from "../state/orderStateMachine.js";
import { buildSignalKey } from "../state/signalDeduper.js";

/**
 * Build a stable signal key from a restored remote order. We don't
 * know the originating strategy so we use "recovered" as the source.
 * Timestamp bucket uses the order's created_at if available, else
 * `now`, which is fine because the bucket is only used to detect
 * near-duplicates from fresh signals after boot.
 */
function recoverySignalKey(remoteOrder) {
  return buildSignalKey({
    source: "recovered",
    marketId: remoteOrder.market || remoteOrder.marketId || remoteOrder.condition_id || "",
    tokenId: remoteOrder.asset_id || remoteOrder.tokenID || remoteOrder.tokenId || "",
    side: String(remoteOrder.side || "").toUpperCase(),
    action: "recovery",
    timestamp: remoteOrder.created_at ? Number(remoteOrder.created_at) * 1000 : Date.now(),
  });
}

/**
 * Recover state from the exchange before live trading begins.
 *
 * @param {Object} deps
 *   @param {Object} deps.client            PolymarketClient
 *   @param {Object} deps.wallet            Wallet
 *   @param {Object} deps.orderStore        OrderStore
 *   @param {Object} deps.positionStore     PositionStore
 *   @param {Object} deps.signalDeduper     SignalDeduper
 *   @param {Object} deps.risk              LiveRiskEngine
 *   @param {Object} deps.killSwitch        KillSwitch
 *   @param {Object} deps.logger
 *   @param {Object} deps.config            LIVE_CONFIG
 *   @param {string[]} [deps.tokenIds]      tokens to pull positions for
 *
 * @returns {Promise<Object>} summary log-shaped
 *   {
 *     ok, mode, startedAt, finishedAt, durationMs,
 *     ordersRestored, positionsRestored, signalsBlocked,
 *     errors
 *   }
 */
export async function runStartupRecovery(deps) {
  const {
    client, wallet, orderStore, positionStore, signalDeduper,
    risk, killSwitch, logger, config,
  } = deps;
  const tokenIds = deps.tokenIds || [];
  const startedAt = Date.now();

  const summary = {
    ok: false,
    mode: config.mode,
    startedAt,
    finishedAt: null,
    durationMs: 0,
    ordersRestored: 0,
    positionsRestored: 0,
    signalsBlocked: 0,
    errors: [],
  };

  // Paper mode has no remote state to recover.
  if (config.mode !== "live") {
    logger.info("recovery:skip_paper_mode");
    summary.ok = true;
    summary.finishedAt = Date.now();
    summary.durationMs = summary.finishedAt - startedAt;
    return summary;
  }

  // Optional feature flag
  if (config.monitoring?.startupRecoveryEnabled === false) {
    logger.warn("recovery:disabled_by_config");
    summary.ok = true;
    summary.skipped = true;
    summary.finishedAt = Date.now();
    summary.durationMs = summary.finishedAt - startedAt;
    return summary;
  }

  logger.info("recovery:starting");

  // ───────────────────────────────────────────────────────────────────
  //  1. Restore open orders
  // ───────────────────────────────────────────────────────────────────
  let remoteOrders = [];
  try {
    remoteOrders = (await client.getOpenOrders()) || [];
    killSwitch?.recordApiSuccess();
  } catch (e) {
    killSwitch?.recordApiFailure({ op: "recovery:getOpenOrders" });
    summary.errors.push({ op: "getOpenOrders", message: e.message });
    logger.errorEvent("recovery:getOpenOrders", e);
  }

  const extIds = [];
  for (const ro of remoteOrders) {
    try {
      const externalOrderId = String(ro.id || ro.orderID || "");
      if (!externalOrderId) continue;
      extIds.push(externalOrderId);

      // Extract fields defensively — shape varies across SDK versions
      const tokenId = ro.asset_id || ro.tokenID || ro.tokenId || "";
      const marketId = ro.market || ro.marketId || ro.condition_id || null;
      const side = String(ro.side || "").toUpperCase();
      const size = Number(ro.original_size ?? ro.size ?? 0);
      const filled = Number(ro.size_matched ?? ro.filledSize ?? 0);
      const price = Number(ro.price ?? 0) || null;
      if (!tokenId || !["BUY", "SELL"].includes(side) || !(size > 0)) {
        summary.errors.push({ op: "recovery:bad_order_shape", externalOrderId });
        continue;
      }

      const signalKey = recoverySignalKey(ro);

      // Create the internal record in IDLE, then walk it forward to
      // the correct resting state. Going directly to ORDER_PLACED
      // would bypass the FSM's invariant that every order passes
      // through SIGNAL_DETECTED first.
      const { duplicate, order } = orderStore.create({
        signalKey, marketId, tokenId, side, size, price,
        meta: { source: "recovered", externalOrderId },
      });
      if (duplicate) {
        // Someone already registered this signal (rare on boot).
        continue;
      }
      orderStore.transition(order.orderId, ORDER_STATES.SIGNAL_DETECTED, { reason: "recovery" });
      const resting = filled > 0 && filled < size
        ? ORDER_STATES.PARTIAL_FILL
        : ORDER_STATES.ORDER_PLACED;
      const tr = orderStore.transition(order.orderId, ORDER_STATES.ORDER_PLACED, {
        externalOrderId, reason: "recovery",
      });
      if (tr.ok && resting === ORDER_STATES.PARTIAL_FILL && filled > 0) {
        const avg = Number(ro.avg_price ?? ro.avgFillPrice ?? price) || null;
        orderStore.transition(order.orderId, ORDER_STATES.PARTIAL_FILL, {
          filledSize: filled, avgFillPrice: avg, reason: "recovery:partial",
        });
      }

      // Populate the dedupe cache so a fresh signal for the same
      // opportunity won't produce a second order in the first ticks
      // after boot.
      signalDeduper.mark(signalKey, { stage: "recovered", orderId: order.orderId, externalOrderId });

      summary.ordersRestored++;
      summary.signalsBlocked++;
      risk?.trackOrder(externalOrderId);
      killSwitch?.recordOrderProgress(order.orderId);
    } catch (e) {
      summary.errors.push({ op: "recovery:restore_order", message: e.message });
      logger.errorEvent("recovery:restore_order", e, { remoteOrder: ro });
    }
  }

  // Sync risk's open-order tracking to reality
  risk?.syncOpenOrders(extIds);

  // ───────────────────────────────────────────────────────────────────
  //  2. Restore positions for known tokens
  // ───────────────────────────────────────────────────────────────────
  const tokensToCheck = new Set([
    ...tokenIds,
    // Ensure we also check positions for tokens we just restored orders for
    ...remoteOrders.map(r => r.asset_id || r.tokenID || r.tokenId).filter(Boolean),
  ]);

  for (const tid of tokensToCheck) {
    try {
      const qty = await wallet.getPositionBalance(tid);
      killSwitch?.recordApiSuccess();
      if (qty && Math.abs(qty) > 1e-9) {
        positionStore.set(tid, {
          tokenId: tid,
          qty,
          // Cost basis unknown on restart — leave at 0 unless already known
          avgEntryPrice: positionStore.get(tid).avgEntryPrice || 0,
          realizedPnl: positionStore.get(tid).realizedPnl || 0,
        });
        summary.positionsRestored++;
      }
    } catch (e) {
      killSwitch?.recordApiFailure({ op: "recovery:getPositionBalance", tid });
      summary.errors.push({ op: "getPositionBalance", tokenId: tid, message: e.message });
    }
  }

  summary.ok = summary.errors.length === 0;
  summary.finishedAt = Date.now();
  summary.durationMs = summary.finishedAt - startedAt;
  logger.decision("recovery:summary", summary);
  return summary;
}
