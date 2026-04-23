// ═══════════════════════════════════════════════════════════════════════
//  src/live/state/positionStore.js — position tracking
// ═══════════════════════════════════════════════════════════════════════
//  Moves position state out of LiveExecutionEngine. In V5.3 the engine
//  tracked a single `Map<tokenId, contractsHeld>` — sufficient for a
//  smoke test but too thin for production: no avg entry, no total cost,
//  no delta reconciliation.
//
//  Design:
//   - One Position record per tokenId
//   - BUY fills increase qty, update weighted-average entry price
//   - SELL fills decrease qty, emit realized PnL vs avg entry
//   - Exchange-reported snapshots can fully REPLACE local state (reconcile)
//
//  All methods are synchronous; network reads are done in the caller
//  (wallet.syncPositions) and handed here via applyFill / restorePositions.
// ═══════════════════════════════════════════════════════════════════════

function round4(x) { return Math.round(x * 10000) / 10000; }

/** Factory for a fresh, empty Position record. */
function emptyPosition(tokenId) {
  return {
    tokenId,
    qty: 0,              // net contracts held (>0 long, <0 short — see notes)
    avgEntryPrice: 0,    // cost basis per contract; meaningful only when qty != 0
    realizedPnl: 0,      // cumulative realized PnL in USDC
    totalBuyQty: 0,
    totalSellQty: 0,
    lastFillAt: null,
    lastUpdate: null,
  };
}

export class PositionStore {
  constructor() {
    this._byToken = new Map();
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Read helpers
  // ═══════════════════════════════════════════════════════════════════
  get(tokenId) {
    return this._byToken.get(tokenId) || emptyPosition(tokenId);
  }

  /** Explicit set — used by reconciliation or restore. */
  set(tokenId, position) {
    if (!tokenId) throw new Error("PositionStore.set: tokenId required");
    if (!position || typeof position !== "object") {
      throw new Error("PositionStore.set: position must be an object");
    }
    const merged = { ...emptyPosition(tokenId), ...position, tokenId, lastUpdate: Date.now() };
    this._byToken.set(tokenId, merged);
    return merged;
  }

  remove(tokenId) {
    return this._byToken.delete(tokenId);
  }

  list() {
    return [...this._byToken.values()];
  }

  // ═══════════════════════════════════════════════════════════════════
  //  applyFill — update position from an actual execution fill
  //
  //  Notes on shorting:
  //   Polymarket outcome tokens can be SOLD only if you hold them (no
  //   native shorting). We still permit negative qty here because some
  //   strategies emit SELL signals that are intended to close long
  //   positions. If qty would go negative we surface a structured
  //   warning but don't reject — policy decisions belong to risk, not
  //   storage.
  // ═══════════════════════════════════════════════════════════════════
  applyFill({ tokenId, side, size, price, orderId, externalOrderId, timestamp }) {
    if (!tokenId) throw new Error("applyFill: tokenId required");
    if (!["BUY", "SELL"].includes(side)) throw new Error(`applyFill: invalid side '${side}'`);
    if (!(size > 0)) throw new Error("applyFill: size must be > 0");
    if (!(price >= 0 && price <= 1)) throw new Error(`applyFill: invalid price ${price}`);

    const now = timestamp || Date.now();
    const cur = this._byToken.get(tokenId) || emptyPosition(tokenId);
    const next = { ...cur };

    if (side === "BUY") {
      // Weighted-average entry over long position
      if (next.qty >= 0) {
        const newQty = next.qty + size;
        next.avgEntryPrice = newQty > 0
          ? round4((next.avgEntryPrice * next.qty + price * size) / newQty)
          : 0;
        next.qty = newQty;
      } else {
        // Buying back a short: realize PnL on the covered portion
        const coverQty = Math.min(size, -next.qty);
        const pnl = round4(coverQty * (next.avgEntryPrice - price));
        next.realizedPnl = round4(next.realizedPnl + pnl);
        next.qty += coverQty;
        const remaining = size - coverQty;
        if (remaining > 0) {
          // Rolled through zero into long — start a new avg
          next.avgEntryPrice = price;
          next.qty = remaining;
        } else if (next.qty === 0) {
          next.avgEntryPrice = 0;
        }
      }
      next.totalBuyQty = round4(next.totalBuyQty + size);
    } else { // SELL
      if (next.qty > 0) {
        const closeQty = Math.min(size, next.qty);
        const pnl = round4(closeQty * (price - next.avgEntryPrice));
        next.realizedPnl = round4(next.realizedPnl + pnl);
        next.qty -= closeQty;
        const remaining = size - closeQty;
        if (next.qty === 0) next.avgEntryPrice = 0;
        if (remaining > 0) {
          // Rolled into short
          next.avgEntryPrice = price;
          next.qty = -remaining;
        }
      } else {
        // Opening or adding to a short
        const shortQty = -next.qty;
        const newShort = shortQty + size;
        next.avgEntryPrice = newShort > 0
          ? round4((next.avgEntryPrice * shortQty + price * size) / newShort)
          : 0;
        next.qty = -newShort;
      }
      next.totalSellQty = round4(next.totalSellQty + size);
    }

    next.lastFillAt = now;
    next.lastUpdate = now;
    // Optional breadcrumbs back to the order that caused this fill
    if (orderId) next.lastOrderId = orderId;
    if (externalOrderId) next.lastExternalOrderId = externalOrderId;

    this._byToken.set(tokenId, next);
    return next;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  restorePositions — wholesale replacement from exchange snapshot
  //
  //  Used during reconciliation when we want to trust the exchange as
  //  authoritative. Resets the local store — any in-flight fills not
  //  yet reflected by the exchange will be lost, which is the correct
  //  behavior for "exchange is truth" reconciliation.
  // ═══════════════════════════════════════════════════════════════════
  restorePositions(positionList) {
    if (!Array.isArray(positionList)) {
      throw new Error("restorePositions: expected array");
    }
    this._byToken.clear();
    for (const p of positionList) {
      if (!p || !p.tokenId) continue;
      this.set(p.tokenId, p);
    }
    return this.list();
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Snapshots + aggregates
  // ═══════════════════════════════════════════════════════════════════

  /** Sum of |qty × avgEntryPrice| across all tokens — proxy for notional. */
  getNetExposure() {
    let gross = 0;
    let net = 0;
    for (const p of this._byToken.values()) {
      const notional = Math.abs(p.qty) * p.avgEntryPrice;
      gross += notional;
      net += p.qty * p.avgEntryPrice;
    }
    return { gross: round4(gross), net: round4(net) };
  }

  snapshot() {
    const positions = this.list();
    const exposure = this.getNetExposure();
    let totalRealizedPnl = 0;
    for (const p of positions) totalRealizedPnl += p.realizedPnl;
    return {
      count: positions.length,
      totalRealizedPnl: round4(totalRealizedPnl),
      exposure,
      positions: positions.map(p => ({
        tokenId: p.tokenId,
        qty: p.qty,
        avgEntryPrice: p.avgEntryPrice,
        realizedPnl: p.realizedPnl,
      })),
    };
  }
}
