// ═══════════════════════════════════════════════════════════════════════
//  scripts/testCalibration.js — the calibration maths
// ═══════════════════════════════════════════════════════════════════════
//  These functions decide whether a hypothesis passes or is killed, so
//  their failure modes matter more than their happy paths. Two in
//  particular:
//
//    - treating correlated markets as independent, which makes any
//      interval look far tighter than the evidence supports
//    - splitting a time series at random, which lets a later event help
//      "predict" an earlier one
//
//  Both are tested directly, not implied.
// ═══════════════════════════════════════════════════════════════════════

import {
  brier, logLoss, baseRate, brierOfBaseRate,
  calibrationBuckets, expectedCalibrationError, byCluster,
  clusterBootstrapCI, walkForwardSplit, economicEdge, makeRng,
  DEFAULT_EDGES,
} from "../src/research/calibration.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  if (!cond) console.error(`  FAIL ${name}${detail ? ": " + detail : ""}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ─── Brier ──────────────────────────────────────────────────────────────
{
  assert("brier: perfect forecast scores 0",
    near(brier([{ p: 1, y: 1 }, { p: 0, y: 0 }]), 0));
  assert("brier: worst forecast scores 1",
    near(brier([{ p: 0, y: 1 }, { p: 1, y: 0 }]), 1));
  assert("brier: total uncertainty scores 0.25",
    near(brier([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }]), 0.25));
  assert("brier: empty input is null", brier([]) === null);

  // Confident and wrong must score worse than uncertain and wrong.
  assert("brier: confidence is penalised when wrong",
    brier([{ p: 0.9, y: 0 }]) > brier([{ p: 0.6, y: 0 }]));
}

// ─── Log loss ───────────────────────────────────────────────────────────
{
  assert("logloss: a certain correct call scores ~0",
    logLoss([{ p: 1, y: 1 }]) < 1e-5);
  assert("logloss: punishes confident errors harder than Brier",
    logLoss([{ p: 0.99, y: 0 }]) / logLoss([{ p: 0.9, y: 0 }]) >
    brier([{ p: 0.99, y: 0 }]) / brier([{ p: 0.9, y: 0 }]));

  // A market at exactly 0 that resolves YES must not poison the average.
  const v = logLoss([{ p: 0, y: 1 }, { p: 0.5, y: 1 }]);
  assert("logloss: an impossible-but-happened case stays finite",
    Number.isFinite(v), String(v));
}

// ─── Base rate as the floor to beat ─────────────────────────────────────
{
  const rows = [
    { p: 0.9, y: 1 }, { p: 0.9, y: 1 }, { p: 0.9, y: 1 }, { p: 0.9, y: 0 },
  ];
  assert("baserate: computed correctly", near(baseRate(rows), 0.75));
  assert("baserate: its Brier is the floor a forecast must clear",
    brierOfBaseRate(rows) > 0 && brierOfBaseRate(rows) < 0.25);

  // A forecaster that only ever repeats the base rate cannot beat it.
  const flat = rows.map(r => ({ p: 0.75, y: r.y }));
  assert("baserate: repeating the base rate exactly matches the floor",
    near(brier(flat), brierOfBaseRate(rows)));
}

// ─── Calibration buckets ────────────────────────────────────────────────
{
  // Deliberately overpriced: everything quoted at 0.60 resolves YES half
  // the time, so the market is 10 points too high.
  const rows = [];
  for (let i = 0; i < 100; i++) {
    rows.push({ p: 0.6, y: i < 50 ? 1 : 0, cluster: "e" + i });
  }
  const b = calibrationBuckets(rows).find(x => x.lo === 0.6);
  assert("buckets: mean probability recovered", near(b.meanP, 0.6));
  assert("buckets: observed frequency recovered", near(b.freq, 0.5));
  assert("buckets: error is signed toward overpricing", near(b.error, 0.1));
  assert("buckets: rows counted", b.n === 100);
  assert("buckets: clusters counted separately from rows", b.clusters === 100);

  // The top edge must be inclusive or every market at exactly 1.0 is lost.
  const edge = calibrationBuckets([{ p: 1.0, y: 1, cluster: "a" }]);
  assert("buckets: a price of exactly 1.0 lands in the last bucket",
    edge[edge.length - 1].n === 1);
  const zero = calibrationBuckets([{ p: 0, y: 0, cluster: "a" }]);
  assert("buckets: a price of exactly 0 lands in the first bucket",
    zero[0].n === 1);

  assert("buckets: empty bands are reported rather than dropped",
    calibrationBuckets([{ p: 0.55, y: 1, cluster: "a" }]).length === DEFAULT_EDGES.length - 1);
}

// ─── ECE weights by clusters, not rows ──────────────────────────────────
{
  // One event with fifty correlated outcomes, all badly priced, plus
  // fifty independent events priced perfectly. Row-weighting would call
  // the whole sample badly calibrated; cluster-weighting should not.
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push({ p: 0.9, y: 0, cluster: "bigEvent" });
  for (let i = 0; i < 50; i++) rows.push({ p: 0.5, y: i < 25 ? 1 : 0, cluster: "solo" + i });

  const ece = expectedCalibrationError(rows);
  // 51 clusters, of which the badly priced one is a single cluster.
  assert("ece: one large event cannot dominate the weighting",
    ece < 0.05, `ece=${ece}`);

  // Sanity: if that event really were fifty independent events, it would.
  const naive = rows.map((r, i) => ({ ...r, cluster: "c" + i }));
  assert("ece: with genuinely independent rows the error is large",
    expectedCalibrationError(naive) > 0.3, String(expectedCalibrationError(naive)));
}

// ─── Clustering ─────────────────────────────────────────────────────────
{
  const rows = [
    { p: 0.5, y: 1, cluster: "a" }, { p: 0.5, y: 0, cluster: "a" },
    { p: 0.5, y: 1, cluster: "b" },
  ];
  const g = byCluster(rows);
  assert("cluster: grouped correctly", g.size === 2 && g.get("a").length === 2);
  assert("cluster: rows without a key are grouped, not dropped",
    byCluster([{ p: 0.5, y: 1 }]).size === 1);
}

// ─── Bootstrap ──────────────────────────────────────────────────────────
{
  const rng1 = makeRng(7), rng2 = makeRng(7);
  assert("rng: seeded and reproducible", rng1() === rng2());
  assert("rng: produces values in [0,1)", (() => {
    const r = makeRng(1); for (let i = 0; i < 500; i++) { const v = r(); if (v < 0 || v >= 1) return false; }
    return true;
  })());

  const rows = [];
  for (let i = 0; i < 200; i++) rows.push({ p: 0.5, y: i % 2, cluster: "c" + i });
  const ci = clusterBootstrapCI(rows, baseRate, { iterations: 300, seed: 1 });
  assert("bootstrap: point estimate matches the sample", near(ci.point, 0.5, 1e-12));
  assert("bootstrap: interval brackets the point", ci.lo <= ci.point && ci.point <= ci.hi);
  assert("bootstrap: cluster count reported", ci.clusters === 200);

  const again = clusterBootstrapCI(rows, baseRate, { iterations: 300, seed: 1 });
  assert("bootstrap: same seed gives the same interval",
    again.lo === ci.lo && again.hi === ci.hi);

  // THE POINT OF THE WHOLE MODULE: correlated rows must widen the
  // interval. Same 200 rows, but they come from 4 events rather than 200.
  const clustered = rows.map((r, i) => ({ ...r, cluster: "e" + (i % 4) }));
  const ciClustered = clusterBootstrapCI(clustered, baseRate, { iterations: 300, seed: 1 });
  assert("bootstrap: fewer independent clusters widen the interval",
    (ciClustered.hi - ciClustered.lo) > (ci.hi - ci.lo),
    `clustered=${(ciClustered.hi - ciClustered.lo).toFixed(4)} independent=${(ci.hi - ci.lo).toFixed(4)}`);

  assert("bootstrap: a single cluster admits no interval",
    clusterBootstrapCI([{ p: 0.5, y: 1, cluster: "only" }], baseRate).lo === null);
}

// ─── Walk-forward ───────────────────────────────────────────────────────
{
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push({ p: 0.5, y: i % 2, cluster: "c" + i, resolvedAt: 1000 + i });
  const { early, late, cutoff } = walkForwardSplit(rows, { fraction: 0.6 });

  assert("walkforward: both halves are populated", early.length > 0 && late.length > 0);
  assert("walkforward: no row appears in both", early.length + late.length === rows.length);
  assert("walkforward: every early row precedes the cutoff",
    early.every(r => r.resolvedAt < cutoff));
  assert("walkforward: every late row is at or after the cutoff",
    late.every(r => r.resolvedAt >= cutoff));
  // The whole reason not to split at random.
  assert("walkforward: no late row precedes any early row",
    Math.max(...early.map(r => r.resolvedAt)) < Math.min(...late.map(r => r.resolvedAt)));

  const undated = walkForwardSplit([{ p: 0.5, y: 1 }], {});
  assert("walkforward: undated rows do not silently become a split",
    undated.late.length === 0);
}

// ─── Economic significance ──────────────────────────────────────────────
{
  const big = economicEdge({ n: 100, error: 0.05 });     // 5 cents mispriced
  assert("economics: a five point gap survives costs", big.tradable === true);
  assert("economics: net is gross minus cost and margin",
    near(big.netCents, 5 - 1 - 0.5));
  assert("economics: an overpriced bucket says sell",
    big.direction.startsWith("sell"));

  const small = economicEdge({ n: 100, error: 0.01 });   // 1 cent
  assert("economics: a one point gap does not survive costs",
    small.tradable === false, `net=${small.netCents}`);

  const under = economicEdge({ n: 100, error: -0.05 });
  assert("economics: an underpriced bucket says buy", under.direction.startsWith("buy"));
  assert("economics: direction does not change the size of the edge",
    near(under.grossCents, big.grossCents));

  assert("economics: an empty bucket yields nothing", economicEdge({ n: 0 }) === null);
}

const passed = results.filter(r => r.pass).length;
console.log("");
console.log("═══════════════════════════════════════════════════");
console.log(`  Calibration tests: ${passed}/${results.length} passed`);
console.log("═══════════════════════════════════════════════════");
if (passed !== results.length) process.exit(1);
