// ═══════════════════════════════════════════════════════════════════════
//  src/research/walletScoring.js — did this wallet beat the market price?
// ═══════════════════════════════════════════════════════════════════════
//  THE QUESTION THIS SERVES
//
//  Do wallets that showed good probability judgement in the past make
//  later trades that predict outcomes better than the price they traded
//  at? Nothing else. Not who made the most money, not who trades the
//  most — whether past judgement predicts future judgement, out of
//  sample.
//
//  WHY PnL PER CONTRACT IS THE SCORE
//
//  A trade is a probability claim. Buying YES at 0.51 asserts the true
//  probability is above 0.51; selling asserts it is below. Held to
//  resolution, the profit per contract IS the distance between that
//  claim and the truth, measured against the price the market offered.
//  A wallet whose mean is zero knows exactly what the market knows. Only
//  a mean above the cost of trading is worth anything.
//
//  Bankroll is deliberately absent. A wallet that stakes a million
//  dollars badly should not outrank one that stakes ten dollars well,
//  and PnL in dollars would say the opposite.
//
//  THE SIDE TRAP
//
//  A Polymarket market has two tokens. Fetching trades by condition id
//  returns both, and buying NO is a bet against YES. Treating every BUY
//  as bullish gets the sign wrong on roughly half the sample and would
//  turn a real signal into noise, or noise into a signal.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Profit per contract, held to resolution.
 *
 * @param {Object} trade
 *   @param {"BUY"|"SELL"} trade.side
 *   @param {number} trade.price          price paid/received for THAT token
 *   @param {0|1} trade.outcomeIndex      0 = YES token, 1 = NO token
 * @param {0|1} yesWon                    1 if the market resolved YES
 * @returns {number|null} cents-per-contract expressed in probability units
 */
export function tradePnl(trade, yesWon) {
  const p = Number(trade.price);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  if (yesWon !== 0 && yesWon !== 1) return null;

  const idx = Number(trade.outcomeIndex);
  if (idx !== 0 && idx !== 1) return null;

  // Did the token being traded end up worth 1?
  const tokenWon = idx === 0 ? yesWon === 1 : yesWon === 0;

  if (trade.side === "BUY") {
    // Paid p, receives 1 if that token won.
    return tokenWon ? 1 - p : -p;
  }
  if (trade.side === "SELL") {
    // Received p, owes 1 if that token won.
    return tokenWon ? -(1 - p) : p;
  }
  return null;
}

/**
 * The market's own claim, for comparison.
 *
 * By construction PnL is measured against the traded price, so a mean of
 * zero means the wallet is exactly as good as the market. This helper
 * exists to make that explicit in reports rather than implied.
 */
export const MARKET_BASELINE_PNL = 0;

/**
 * Score one wallet over a set of scored trades.
 *
 * `meanPnl` is the headline. `n` and `markets` are reported beside it
 * because a mean over four trades in one market is not a score, and any
 * ranking that ignores that will rank luck.
 */
export function scoreWallet(trades) {
  if (!trades.length) return null;
  const pnls = trades.map(t => t.pnl).filter(Number.isFinite);
  if (!pnls.length) return null;
  const n = pnls.length;
  const mean = pnls.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1
    ? pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
    : 0;
  const wins = pnls.filter(v => v > 0).length;
  return {
    n,
    markets: new Set(trades.map(t => t.marketId)).size,
    events: new Set(trades.map(t => t.cluster)).size,
    meanPnl: mean,
    sd: Math.sqrt(variance),
    // Mean over its own standard error. Not a p-value — a crude way to
    // stop a huge mean from a handful of trades outranking a modest one
    // from hundreds.
    tStat: variance > 0 ? mean / (Math.sqrt(variance) / Math.sqrt(n)) : 0,
    winRate: wins / n,
    totalPnl: pnls.reduce((s, v) => s + v, 0),
  };
}

/**
 * Score every wallet using ONLY markets resolved before the cutoff.
 *
 * The filter is the whole point. Scoring a wallet on a market that
 * resolves after the cutoff and then testing it on that same period is
 * not a test, it is a description. The function takes the cutoff rather
 * than trusting the caller to have filtered, because that mistake is
 * silent and fatal.
 *
 * @param {Array} trades  each needs {wallet, pnl, resolvedAt, marketId, cluster}
 * @param {number} cutoff epoch ms
 */
export function scoreWalletsBefore(trades, cutoff, { minTrades = 10, minEvents = 3 } = {}) {
  const eligible = trades.filter(t => Number.isFinite(t.resolvedAt) && t.resolvedAt < cutoff);
  const byWallet = new Map();
  for (const t of eligible) {
    if (!byWallet.has(t.wallet)) byWallet.set(t.wallet, []);
    byWallet.get(t.wallet).push(t);
  }
  const out = new Map();
  for (const [w, ts] of byWallet) {
    const s = scoreWallet(ts);
    if (!s) continue;
    // A wallet seen a handful of times in one event has no track record,
    // only an anecdote.
    if (s.n < minTrades || s.events < minEvents) continue;
    out.set(w, s);
  }
  return out;
}

/**
 * Split wallets into deciles by a score field.
 *
 * Deciles rather than a hand-picked top-N: picking the threshold after
 * seeing the answer is how a null result becomes a positive one. The
 * whole distribution is reported so a monotone relationship — or its
 * absence — is visible.
 */
export function decileByScore(scores, field = "meanPnl") {
  const arr = [...scores.entries()]
    .map(([wallet, s]) => ({ wallet, ...s }))
    .filter(x => Number.isFinite(x[field]))
    .sort((a, b) => a[field] - b[field]);
  const out = new Map();
  if (!arr.length) return { deciles: out, ordered: arr };
  for (let i = 0; i < arr.length; i++) {
    const d = Math.min(9, Math.floor((i / arr.length) * 10));
    if (!out.has(d)) out.set(d, []);
    out.get(d).push(arr[i]);
  }
  return { deciles: out, ordered: arr };
}

/**
 * How independent are these wallets really?
 *
 * Five wallets buying the same side of the same market within a minute
 * are not five opinions. They may be one person, one signal service, or
 * one copy-trading bot. Aggregating them as independent evidence
 * multiplies apparent confidence without adding information.
 *
 * Returns, for each pair that overlaps enough to judge, the share of
 * (market, side) pairs they both took. High overlap across many wallets
 * means the group should be treated as far smaller than it looks.
 */
export function overlapMatrix(trades, wallets, { minShared = 5 } = {}) {
  const sig = new Map();          // wallet -> Set of "market|side"
  for (const t of trades) {
    if (!wallets.has(t.wallet)) continue;
    if (!sig.has(t.wallet)) sig.set(t.wallet, new Set());
    sig.get(t.wallet).add(`${t.marketId}|${t.outcomeIndex}|${t.side}`);
  }
  const list = [...sig.keys()];
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = sig.get(list[i]), b = sig.get(list[j]);
      let shared = 0;
      for (const k of a) if (b.has(k)) shared++;
      if (shared < minShared) continue;
      pairs.push({
        a: list[i], b: list[j], shared,
        jaccard: shared / (a.size + b.size - shared),
      });
    }
  }
  pairs.sort((x, y) => y.jaccard - x.jaccard);
  return pairs;
}
