// ═══════════════════════════════════════════════════════════════════════
//  src/backtest/metrics.js — V5.8 Phase 3: Performance metrics
// ═══════════════════════════════════════════════════════════════════════
//  Pure functions over an equity curve ([{t, equity}]) and a trade log.
//  Sharpe is computed on per-tick returns and annualized from the median
//  tick interval — with sparse polling data treat it as directional, not
//  gospel.
// ═══════════════════════════════════════════════════════════════════════

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

export function maxDrawdown(curve) {
  let peak = -Infinity;
  let maxDD = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return maxDD;
}

export function tickReturns(curve) {
  const rets = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity;
    if (prev > 0) rets.push(curve[i].equity / prev - 1);
  }
  return rets;
}

export function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function medianTickMs(curve) {
  const gaps = [];
  for (let i = 1; i < curve.length; i++) gaps.push(curve[i].t - curve[i - 1].t);
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

export function sharpe(curve) {
  const rets = tickReturns(curve);
  const sd = stdev(rets);
  if (sd === 0) return 0;
  const perTick = mean(rets) / sd;
  const tickMs = medianTickMs(curve);
  if (tickMs <= 0) return perTick;
  const ticksPerYear = MS_PER_YEAR / tickMs;
  return perTick * Math.sqrt(ticksPerYear);
}

export function tradeStats(trades) {
  const closes = trades.filter(tr => tr.side === "SELL");
  const wins = closes.filter(tr => tr.realized > 0);
  const losses = closes.filter(tr => tr.realized < 0);
  const grossWin = wins.reduce((s, tr) => s + tr.realized, 0);
  const grossLoss = Math.abs(losses.reduce((s, tr) => s + tr.realized, 0));
  return {
    tradeCount: trades.length,
    closedCount: closes.length,
    hitRate: closes.length ? wins.length / closes.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    totalNotional: trades.reduce((s, tr) => s + tr.notional, 0),
    avgSlippageBps: trades.length
      ? mean(trades.map(tr => (tr.slippagePct || 0) * 10_000))
      : 0,
  };
}

/**
 * Full report from a completed run.
 */
export function computeMetrics({ curve, trades, initialEquity, feesPaid = 0 }) {
  const finalEquity = curve.length ? curve[curve.length - 1].equity : initialEquity;
  const durationMs = curve.length >= 2 ? curve[curve.length - 1].t - curve[0].t : 0;
  return {
    initialEquity,
    finalEquity,
    totalReturnPct: initialEquity > 0 ? (finalEquity / initialEquity - 1) * 100 : 0,
    maxDrawdownPct: maxDrawdown(curve) * 100,
    sharpe: sharpe(curve),
    durationHours: durationMs / 3_600_000,
    ticks: curve.length,
    feesPaid,
    ...tradeStats(trades),
  };
}
