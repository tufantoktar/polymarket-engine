// ═══════════════════════════════════════════════════════════════════════
//  src/backtest/fillModel.js — V5.8 Phase 3: Execution simulation
// ═══════════════════════════════════════════════════════════════════════
//  Simulates taker fills against a RECORDED orderbook by walking real
//  depth levels. This is intentionally conservative:
//    - BUY consumes asks (worst-first for us: ascending price)
//    - SELL consumes bids (descending price)
//    - Slippage measured vs. midPrice at decision time
//    - Orders whose slippage would exceed maxSlippagePct are rejected
//      outright (mirrors src/live/execution/slippage.js philosophy)
//    - Fees charged in bps of filled notional
//
//  What it does NOT model (documented limitation, keep expectations
//  honest): queue position / maker fills, our own market impact on
//  subsequent snapshots, adverse selection between snapshot intervals.
//  Backtest results are therefore an UPPER BOUND on realizable edge.
// ═══════════════════════════════════════════════════════════════════════

export const DEFAULT_FILL_OPTS = {
  maxSlippagePct: 0.02,   // 2% of mid, aligned with live slippage guard spirit
  feeBps: 0,              // Polymarket taker fee currently 0; keep configurable
  allowPartial: true,     // insufficient depth -> partial fill (else reject)
};

/**
 * Simulate a taker fill.
 *
 * @param {object} book  Normalized book {bids, asks, midPrice}
 * @param {"BUY"|"SELL"} side  BUY = buy YES shares, SELL = sell YES shares
 * @param {number} size  Desired share quantity (> 0)
 * @param {object} opts  See DEFAULT_FILL_OPTS
 * @returns {{filled:boolean, filledSize:number, avgPrice:number, notional:number,
 *            fee:number, slippagePct:number, levelsUsed:number, reason:string|null}}
 */
export function simulateFill(book, side, size, opts = {}) {
  const o = { ...DEFAULT_FILL_OPTS, ...opts };
  const reject = reason => ({
    filled: false, filledSize: 0, avgPrice: 0, notional: 0,
    fee: 0, slippagePct: 0, levelsUsed: 0, reason,
  });

  if (!book || typeof book.midPrice !== "number") return reject("no_book");
  if (!(size > 0)) return reject("bad_size");

  const levels = side === "BUY" ? book.asks : book.bids;
  if (!Array.isArray(levels) || levels.length === 0) return reject("empty_side");

  let remaining = size;
  let notional = 0;
  let filledSize = 0;
  let levelsUsed = 0;

  for (const lvl of levels) {
    if (remaining <= 1e-12) break;
    const px = Number(lvl.price);
    const avail = Number(lvl.size);
    if (!(px > 0) || !(avail > 0)) continue;

    const take = Math.min(remaining, avail);

    // Slippage check BEFORE consuming this level: would our running
    // average after taking this level breach the cap?
    const nextNotional = notional + take * px;
    const nextFilled = filledSize + take;
    const nextAvg = nextNotional / nextFilled;
    const slip = side === "BUY"
      ? (nextAvg - book.midPrice) / book.midPrice
      : (book.midPrice - nextAvg) / book.midPrice;

    if (slip > o.maxSlippagePct) {
      // Stop walking. What we have so far (if anything) stands.
      break;
    }

    notional = nextNotional;
    filledSize = nextFilled;
    remaining -= take;
    levelsUsed++;
  }

  if (filledSize <= 0) return reject("slippage_or_no_depth");
  if (remaining > 1e-9 && !o.allowPartial) return reject("partial_disallowed");

  const avgPrice = notional / filledSize;
  const slippagePct = side === "BUY"
    ? (avgPrice - book.midPrice) / book.midPrice
    : (book.midPrice - avgPrice) / book.midPrice;
  const fee = notional * (o.feeBps / 10_000);

  return {
    filled: true,
    filledSize,
    avgPrice,
    notional,
    fee,
    slippagePct,
    levelsUsed,
    reason: remaining > 1e-9 ? "partial" : null,
  };
}
