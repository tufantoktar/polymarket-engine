// ═══════════════════════════════════════════════════════════════════════
//  src/research/calibration.js — is a stated probability honest?
// ═══════════════════════════════════════════════════════════════════════
//  The market is a forecaster. Before asking whether anything beats it,
//  measure how good it is: of everything it prices at 0.60, does roughly
//  60% happen? A market that is well calibrated leaves nothing to
//  exploit by simply disagreeing with it.
//
//  Two traps this module exists to avoid.
//
//  INDEPENDENCE. Polymarket lists an event as several mutually exclusive
//  markets — "who will be the nominee" becomes one market per candidate.
//  Those outcomes are not separate observations: exactly one resolves
//  YES by construction, and they move together. Counting them as
//  independent inflates the sample and shrinks every confidence interval
//  by a factor that has nothing to do with information. Every statistic
//  here therefore takes a cluster key, and uncertainty is estimated by
//  resampling CLUSTERS, not rows.
//
//  QUANTITY VERSUS QUALITY. Accuracy is the wrong metric for a
//  forecaster. A model that says 0.99 to everything and is right 99% of
//  the time is accurate and useless. Brier score and log loss reward
//  being right AND being appropriately uncertain; calibration error asks
//  only whether the stated probability matches the observed frequency.
//  They answer different questions and all three are reported.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Mean squared error of a probabilistic forecast. Lower is better.
 * A forecast that always says the base rate scores the variance of the
 * outcome, which is the number to beat.
 *
 * @param {Array<{p:number, y:0|1}>} rows
 */
export function brier(rows) {
  if (!rows.length) return null;
  let s = 0;
  for (const r of rows) s += (r.p - r.y) ** 2;
  return s / rows.length;
}

/**
 * Log loss. Punishes confident errors far harder than Brier does, which
 * is what you want when the cost of being wrong is losing the stake.
 * Probabilities are clipped: a market at exactly 0 or 1 that resolves the
 * other way would otherwise make the score infinite and destroy the
 * average for everyone else.
 */
export function logLoss(rows, eps = 1e-6) {
  if (!rows.length) return null;
  let s = 0;
  for (const r of rows) {
    const p = Math.min(1 - eps, Math.max(eps, r.p));
    s += r.y === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return s / rows.length;
}

/** Base rate — the fraction that resolved YES. */
export function baseRate(rows) {
  if (!rows.length) return null;
  return rows.reduce((s, r) => s + r.y, 0) / rows.length;
}

/**
 * Brier score of the trivial forecaster that always predicts the base
 * rate. This is the floor a real forecast has to clear; beating it is
 * the minimum evidence of skill.
 */
export function brierOfBaseRate(rows) {
  const b = baseRate(rows);
  if (b === null) return null;
  return brier(rows.map(r => ({ p: b, y: r.y })));
}

export const DEFAULT_EDGES = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0];

/**
 * Reliability table: for each price band, the mean stated probability
 * against the observed frequency. The gap is the mispricing, in
 * probability units, which is also cents per contract.
 */
export function calibrationBuckets(rows, edges = DEFAULT_EDGES) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const last = i === edges.length - 2;
    const sub = rows.filter(r => r.p >= lo && (last ? r.p <= hi : r.p < hi));
    if (!sub.length) { out.push({ lo, hi, n: 0 }); continue; }
    const meanP = sub.reduce((s, r) => s + r.p, 0) / sub.length;
    const freq = sub.reduce((s, r) => s + r.y, 0) / sub.length;
    out.push({
      lo, hi, n: sub.length,
      clusters: new Set(sub.map(r => r.cluster)).size,
      meanP, freq,
      // Positive means the market priced it too high — YES was overbought
      // and the tradable direction is to sell.
      error: meanP - freq,
    });
  }
  return out;
}

/**
 * Expected calibration error: bucket errors weighted by how much of the
 * sample each bucket holds. Weighted by CLUSTERS rather than rows so a
 * single event with forty outcomes does not dominate.
 */
export function expectedCalibrationError(rows, edges = DEFAULT_EDGES) {
  const buckets = calibrationBuckets(rows, edges).filter(b => b.n > 0);
  if (!buckets.length) return null;
  const totalClusters = buckets.reduce((s, b) => s + b.clusters, 0);
  if (!totalClusters) return null;
  return buckets.reduce((s, b) => s + (b.clusters / totalClusters) * Math.abs(b.error), 0);
}

/**
 * Group rows by cluster. Exposed because several callers need the
 * grouping and getting it wrong is the whole risk.
 */
export function byCluster(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = r.cluster ?? "__none__";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/**
 * Deterministic PRNG so a reported interval can be reproduced exactly.
 * mulberry32 — small, well distributed enough for resampling.
 */
export function makeRng(seed = 42) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Confidence interval by resampling CLUSTERS with replacement.
 *
 * The ordinary bootstrap resamples rows, which assumes rows are
 * independent. They are not: one event contributes many correlated
 * markets. Resampling whole clusters keeps that correlation intact, so
 * the interval reflects how much independent evidence there actually is.
 * On this data the difference is not cosmetic — it is often several
 * times wider.
 *
 * @param {Array} rows          each needs a `cluster` field
 * @param {Function} statistic  rows -> number
 * @param {Object} opts
 */
export function clusterBootstrapCI(rows, statistic, { iterations = 1000, alpha = 0.05, seed = 42 } = {}) {
  const clusters = [...byCluster(rows).values()];
  if (clusters.length < 2) {
    return { point: statistic(rows), lo: null, hi: null, clusters: clusters.length,
             note: "too few clusters for an interval" };
  }
  const rng = makeRng(seed);
  const stats = [];
  for (let i = 0; i < iterations; i++) {
    const sample = [];
    for (let c = 0; c < clusters.length; c++) {
      sample.push(...clusters[Math.floor(rng() * clusters.length)]);
    }
    const v = statistic(sample);
    if (Number.isFinite(v)) stats.push(v);
  }
  if (!stats.length) return { point: statistic(rows), lo: null, hi: null, clusters: clusters.length };
  stats.sort((a, b) => a - b);
  const q = f => stats[Math.min(stats.length - 1, Math.max(0, Math.floor(f * stats.length)))];
  return {
    point: statistic(rows),
    lo: q(alpha / 2),
    hi: q(1 - alpha / 2),
    clusters: clusters.length,
    iterations: stats.length,
  };
}

/**
 * Split by time for an out-of-sample test.
 *
 * Random splits are wrong for anything with a time axis: a market
 * resolving in March would end up "predicting" one from January. The cut
 * is a resolution date, and the caller gets both halves plus the date so
 * it can be reported rather than assumed.
 */
export function walkForwardSplit(rows, { fraction = 0.6, dateKey = "resolvedAt" } = {}) {
  const dated = rows.filter(r => Number.isFinite(r[dateKey])).sort((a, b) => a[dateKey] - b[dateKey]);
  if (dated.length < 10) return { early: dated, late: [], cutoff: null };
  const idx = Math.floor(dated.length * fraction);
  const cutoff = dated[idx][dateKey];
  return {
    early: dated.filter(r => r[dateKey] < cutoff),
    late: dated.filter(r => r[dateKey] >= cutoff),
    cutoff,
  };
}

/**
 * Turn a calibration gap into money.
 *
 * A bucket priced at 0.60 that resolves YES 55% of the time is
 * mispriced by 5 probability points, which is 5 cents per contract on a
 * position held to resolution. Against it stands the cost of getting in:
 * one tick of spread crossed on entry, and nothing on exit because the
 * contract settles rather than being sold.
 *
 * The comparison is deliberately conservative. If the edge does not
 * clear cost by a clear margin it is not an edge, whatever its p-value.
 */
export function economicEdge(bucket, { entryCostCents = 1.0, safetyCents = 0.5 } = {}) {
  if (!bucket || !bucket.n) return null;
  const grossCents = Math.abs(bucket.error) * 100;
  const netCents = grossCents - entryCostCents - safetyCents;
  return {
    grossCents,
    entryCostCents,
    safetyCents,
    netCents,
    tradable: netCents > 0,
    direction: bucket.error > 0 ? "sell YES (priced too high)" : "buy YES (priced too low)",
  };
}
