// ═══════════════════════════════════════════════════════════════════════
//  src/backtest/portfolio.js — V5.8 Phase 3: Backtest accounting
// ═══════════════════════════════════════════════════════════════════════
//  Cash + per-token positions with average-cost basis. Long-only in YES
//  shares (BUY opens/extends, SELL reduces/closes) — mirrors what the
//  live MarketScanner rec->order mapping actually produces today.
//  Mark-to-market uses last known midPrice per token.
// ═══════════════════════════════════════════════════════════════════════

export class BacktestPortfolio {
  constructor({ initialEquity = 1000 } = {}) {
    this.initialEquity = initialEquity;
    this.cash = initialEquity;
    this.positions = new Map();   // tokenId -> { qty, avgPrice }
    this.trades = [];             // closed+open fills, chronological
    this.realizedPnl = 0;
    this.feesPaid = 0;
  }

  position(tokenId) {
    return this.positions.get(tokenId) || { qty: 0, avgPrice: 0 };
  }

  /**
   * Apply a simulated fill.
   * @param {string} tokenId
   * @param {"BUY"|"SELL"} side
   * @param {object} fill  Result of simulateFill (must be filled:true)
   * @param {number} t     Event time
   * @param {object} meta  Optional {source, mid}
   */
  applyFill(tokenId, side, fill, t, meta = {}) {
    if (!fill?.filled || fill.filledSize <= 0) return null;
    const pos = this.position(tokenId);
    let realized = 0;
    let qty = fill.filledSize;

    if (side === "BUY") {
      const newQty = pos.qty + qty;
      const newAvg = newQty > 0
        ? (pos.qty * pos.avgPrice + fill.notional) / newQty
        : 0;
      this.positions.set(tokenId, { qty: newQty, avgPrice: newAvg });
      this.cash -= fill.notional;
    } else {
      // SELL reduces an existing long; clamp to available qty (no shorting).
      qty = Math.min(qty, pos.qty);
      if (qty <= 0) return null;
      const proceeds = qty * fill.avgPrice;
      realized = qty * (fill.avgPrice - pos.avgPrice);
      const newQty = pos.qty - qty;
      if (newQty <= 1e-12) this.positions.delete(tokenId);
      else this.positions.set(tokenId, { qty: newQty, avgPrice: pos.avgPrice });
      this.cash += proceeds;
      this.realizedPnl += realized;
    }

    this.cash -= fill.fee;
    this.feesPaid += fill.fee;

    const trade = {
      t, tokenId, side, qty,
      price: fill.avgPrice,
      notional: qty * fill.avgPrice,
      fee: fill.fee,
      slippagePct: fill.slippagePct,
      realized,
      source: meta.source || null,
      mid: meta.mid ?? null,
    };
    this.trades.push(trade);
    return trade;
  }

  /** Unrealized PnL given a Map/object of tokenId -> midPrice. */
  unrealizedPnl(prices) {
    let u = 0;
    for (const [tokenId, pos] of this.positions) {
      const px = prices instanceof Map ? prices.get(tokenId) : prices?.[tokenId];
      if (typeof px === "number") u += pos.qty * (px - pos.avgPrice);
    }
    return u;
  }

  /** Total equity = cash + market value of open positions. */
  equity(prices) {
    let mv = 0;
    for (const [tokenId, pos] of this.positions) {
      const px = prices instanceof Map ? prices.get(tokenId) : prices?.[tokenId];
      mv += pos.qty * (typeof px === "number" ? px : pos.avgPrice);
    }
    return this.cash + mv;
  }

  grossExposure(prices) {
    let g = 0;
    for (const [tokenId, pos] of this.positions) {
      const px = prices instanceof Map ? prices.get(tokenId) : prices?.[tokenId];
      g += Math.abs(pos.qty * (typeof px === "number" ? px : pos.avgPrice));
    }
    return g;
  }
}
