// ═══════════════════════════════════════════════════════════════════════
//  src/live/execution/slippage.js — pre-trade slippage & liquidity guard
// ═══════════════════════════════════════════════════════════════════════
//  Pure functions. No I/O, no shared state. Every input is explicit so
//  they're easy to unit-test and safe to call from any module.
//
//  Purpose: walk the book depth before submitting an order to answer
//    1. If I send this size, what average price will I actually get?
//    2. How much worse is that than the reference (signal / mid)?
//    3. Is there enough depth at all to consider sending?
//
//  Consumed from liveExecution.placeOrder as the last gate before
//  client.placeOrder(). Designed to reject orders that would sweep
//  the book, not to clamp them silently — clamping belongs to risk.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Walk the book on the opposite side of the trade and compute the
 * volume-weighted average fill price for `size` contracts.
 *
 * BUY  → walks ASKS (we consume asks, paying up)
 * SELL → walks BIDS (we hit bids, taking lower)
 *
 * @param {Object} book   { bids: [{price,size}], asks: [{price,size}] }
 * @param {"BUY"|"SELL"} side
 * @param {number} size   contracts we want to execute
 * @returns {Object}
 *   { estimatedPrice, filledSize, shortfall, levelsTouched }
 */
export function estimateExecutionPrice(book, side, size) {
  if (!book || typeof book !== "object") {
    throw new Error("estimateExecutionPrice: book required");
  }
  if (!["BUY", "SELL"].includes(side)) {
    throw new Error(`estimateExecutionPrice: invalid side '${side}'`);
  }
  if (!(size > 0)) {
    throw new Error(`estimateExecutionPrice: size must be > 0 (got ${size})`);
  }

  const levels = side === "BUY"
    ? (book.asks || []).slice().sort((a, b) => a.price - b.price)
    : (book.bids || []).slice().sort((a, b) => b.price - a.price);

  let remaining = size;
  let notional = 0;
  let touched = 0;

  for (const lvl of levels) {
    if (remaining <= 0) break;
    const px = Number(lvl.price);
    const sz = Number(lvl.size);
    if (!(px > 0) || !(sz > 0)) continue;
    const take = Math.min(remaining, sz);
    notional += take * px;
    remaining -= take;
    touched++;
  }

  const filledSize = size - remaining;
  const estimatedPrice = filledSize > 0 ? +(notional / filledSize).toFixed(6) : null;

  return {
    estimatedPrice,
    filledSize,
    shortfall: +remaining.toFixed(6),
    levelsTouched: touched,
  };
}

/**
 * Compute slippage in bps relative to a reference price.
 * Direction-aware: for BUY, paying more than ref is positive slippage.
 * For SELL, getting less than ref is positive slippage.
 *
 * Returns 0 if either price is missing; returns the raw signed bps
 * so the caller can also detect "price improvement" (negative bps).
 */
export function computeSlippage(estimatedPrice, referencePrice, side) {
  if (!(estimatedPrice > 0) || !(referencePrice > 0)) return { slippageBps: 0, diff: 0 };
  const diff = side === "BUY"
    ? estimatedPrice - referencePrice
    : referencePrice - estimatedPrice;
  const slippageBps = +(diff / referencePrice * 10000).toFixed(2);
  return { slippageBps, diff: +diff.toFixed(6) };
}

/**
 * Liquidity check: total USDC notional available on the relevant side.
 * BUY  → ask depth matters (we are consuming asks)
 * SELL → bid depth matters
 */
export function checkLiquidity(book, side) {
  if (!book) return 0;
  const levels = side === "BUY" ? (book.asks || []) : (book.bids || []);
  let notional = 0;
  for (const lvl of levels) {
    const px = Number(lvl.price), sz = Number(lvl.size);
    if (px > 0 && sz > 0) notional += px * sz;
  }
  return +notional.toFixed(4);
}

/**
 * Top-level guard used by liveExecution.
 *
 * @param {Object} args
 *   @param {Object} args.book             orderbook snapshot
 *   @param {"BUY"|"SELL"} args.side
 *   @param {number} args.size             requested contracts
 *   @param {number} [args.referencePrice] the signal-expected price (defaults to mid)
 *   @param {number} [args.maxSlippageBps] threshold — reject above this
 *   @param {number} [args.minLiquidity]   threshold — reject below this (USDC notional)
 *
 * @returns {Object}
 *   {
 *     allowed,
 *     estimatedPrice,
 *     referencePrice,
 *     slippage,              // absolute bps, unsigned
 *     slippageBps,           // signed, for diagnostics
 *     availableLiquidity,
 *     levelsTouched,
 *     shortfall,
 *     reason                 // human-readable on rejection, else null
 *   }
 */
export function evaluateSlippageAndLiquidity({
  book,
  side,
  size,
  referencePrice = null,
  maxSlippageBps = 50,
  minLiquidity = 0,
}) {
  if (!book) {
    return {
      allowed: false, estimatedPrice: null, referencePrice,
      slippage: null, slippageBps: null, availableLiquidity: 0,
      levelsTouched: 0, shortfall: size, reason: "no_orderbook",
    };
  }

  const availableLiquidity = checkLiquidity(book, side);
  const refPx = referencePrice ?? book.midPrice ?? null;

  // Early reject: not enough total depth
  if (minLiquidity > 0 && availableLiquidity < minLiquidity) {
    return {
      allowed: false,
      estimatedPrice: null,
      referencePrice: refPx,
      slippage: null,
      slippageBps: null,
      availableLiquidity,
      levelsTouched: 0,
      shortfall: size,
      reason: `insufficient_liquidity:${availableLiquidity.toFixed(2)}<${minLiquidity}`,
    };
  }

  const est = estimateExecutionPrice(book, side, size);

  // Not enough depth to fill the size at any price
  if (est.shortfall > 0) {
    return {
      allowed: false,
      estimatedPrice: est.estimatedPrice,
      referencePrice: refPx,
      slippage: null,
      slippageBps: null,
      availableLiquidity,
      levelsTouched: est.levelsTouched,
      shortfall: est.shortfall,
      reason: `book_too_thin:shortfall=${est.shortfall}`,
    };
  }

  const { slippageBps } = computeSlippage(est.estimatedPrice, refPx, side);
  const absSlip = Math.abs(slippageBps);

  if (absSlip > maxSlippageBps) {
    return {
      allowed: false,
      estimatedPrice: est.estimatedPrice,
      referencePrice: refPx,
      slippage: absSlip,
      slippageBps,
      availableLiquidity,
      levelsTouched: est.levelsTouched,
      shortfall: 0,
      reason: `slippage:${absSlip.toFixed(1)}bps>${maxSlippageBps}`,
    };
  }

  return {
    allowed: true,
    estimatedPrice: est.estimatedPrice,
    referencePrice: refPx,
    slippage: absSlip,
    slippageBps,
    availableLiquidity,
    levelsTouched: est.levelsTouched,
    shortfall: 0,
    reason: null,
  };
}
