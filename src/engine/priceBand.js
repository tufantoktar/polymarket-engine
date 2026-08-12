// ═══════════════════════════════════════════════════════════════════════
//  src/engine/priceBand.js — tradable price band, shared by every signal
// ═══════════════════════════════════════════════════════════════════════
//  WHY THIS IS ONE MODULE AND NOT AN INLINE CHECK
//
//  The band started as two inline conditions in momSigs and orderflowSigs
//  (`if (px > 0.90 || px < 0.10) continue`), added after a backtest showed
//  ~98% of trades happening at extreme prices and producing a fake +6.67%
//  return. When smartMoneySigs was written in V5.9 the check was simply
//  forgotten, and the first run with smart money enabled bought a token at
//  0.9840 which then went to zero. A rule that every signal must obey does
//  not belong in each signal.
//
//  WHY 0.20–0.80 AND NOT 0.10–0.90
//
//  Buying YES at price p risks p to win (1 - p). The reward-to-risk ratio
//  is therefore (1 - p) / p:
//
//      p = 0.90  →  0.11 : 1   (need >90% accuracy to break even)
//      p = 0.80  →  0.25 : 1
//      p = 0.50  →  1.00 : 1
//      p = 0.20  →  4.00 : 1
//      p = 0.10  →  9.00 : 1   (mirror image, for the NO side)
//
//  The old 0.10/0.90 band permitted 9:1 risk-to-reward. Beating a market
//  that is already 90% confident requires the signal to be better informed
//  than the market's own estimate, and no momentum or orderflow signal in
//  this engine has demonstrated that. 0.20–0.80 caps the asymmetry at 4:1,
//  which is a stated risk preference rather than an arbitrary round number.
//
//  This is a strategy parameter, so it is configurable. The default is the
//  conservative choice.
// ═══════════════════════════════════════════════════════════════════════

/** Default tradable band. See the reward-to-risk table above. */
export const DEFAULT_PRICE_BAND = Object.freeze({ min: 0.20, max: 0.80 });

/**
 * Is this a price we are willing to trade at all?
 *
 * Rejects non-finite prices too: a NaN mid must never reach sizing.
 *
 * @param {number} px             YES price (0..1)
 * @param {{min:number,max:number}} [band]
 * @returns {boolean}
 */
export function isTradablePrice(px, band = DEFAULT_PRICE_BAND) {
  if (!Number.isFinite(px)) return false;
  const min = Number.isFinite(band?.min) ? band.min : DEFAULT_PRICE_BAND.min;
  const max = Number.isFinite(band?.max) ? band.max : DEFAULT_PRICE_BAND.max;
  return px >= min && px <= max;
}

/**
 * Reward-to-risk for taking `dir` at YES price `px`.
 *
 * BUY_YES  risks px       to win (1 - px)
 * BUY_NO   risks (1 - px) to win px
 *
 * Exposed so sizing and diagnostics can reason about payoff shape rather
 * than re-deriving it, and so tests can assert the band matches the ratio
 * it claims to enforce.
 *
 * @param {number} px
 * @param {"BUY_YES"|"BUY_NO"} dir
 * @returns {number} ratio, or 0 for a degenerate price
 */
export function rewardRiskRatio(px, dir) {
  if (!Number.isFinite(px) || px <= 0 || px >= 1) return 0;
  const risk = dir === "BUY_NO" ? 1 - px : px;
  const reward = dir === "BUY_NO" ? px : 1 - px;
  return risk > 0 ? reward / risk : 0;
}

/**
 * Resolve a band from a config object, falling back to the default.
 * Accepts either {priceBand:{min,max}} or flat {minPrice,maxPrice}.
 */
export function resolvePriceBand(cfg) {
  const b = cfg?.priceBand;
  if (b && (Number.isFinite(b.min) || Number.isFinite(b.max))) {
    return {
      min: Number.isFinite(b.min) ? b.min : DEFAULT_PRICE_BAND.min,
      max: Number.isFinite(b.max) ? b.max : DEFAULT_PRICE_BAND.max,
    };
  }
  if (Number.isFinite(cfg?.minPrice) || Number.isFinite(cfg?.maxPrice)) {
    return {
      min: Number.isFinite(cfg.minPrice) ? cfg.minPrice : DEFAULT_PRICE_BAND.min,
      max: Number.isFinite(cfg.maxPrice) ? cfg.maxPrice : DEFAULT_PRICE_BAND.max,
    };
  }
  return { ...DEFAULT_PRICE_BAND };
}
