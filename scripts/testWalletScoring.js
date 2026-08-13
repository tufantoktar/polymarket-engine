// ═══════════════════════════════════════════════════════════════════════
//  scripts/testWalletScoring.js — the wallet scoring maths
// ═══════════════════════════════════════════════════════════════════════
//  Two mistakes here would produce a confident wrong answer rather than
//  an obvious crash, so both are tested directly:
//
//    - getting the side wrong. Fetching trades by condition id returns
//      both tokens, and buying NO is a bet against YES. Treat every BUY
//      as bullish and half the sample carries the wrong sign.
//
//    - letting a wallet's score see a market that resolved after the
//      cutoff. That turns the out-of-sample test into a restatement of
//      the training data, and it fails silently.
// ═══════════════════════════════════════════════════════════════════════

import {
  tradePnl, scoreWallet, scoreWalletsBefore, decileByScore, overlapMatrix,
  MARKET_BASELINE_PNL,
} from "../src/research/walletScoring.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  if (!cond) console.error(`  FAIL ${name}${detail ? ": " + detail : ""}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ─── The four ways to be right or wrong ─────────────────────────────────
{
  assert("pnl: buy YES, YES wins -> +0.60",
    near(tradePnl({ side: "BUY", price: 0.4, outcomeIndex: 0 }, 1), 0.6));
  assert("pnl: buy YES, NO wins -> -0.40",
    near(tradePnl({ side: "BUY", price: 0.4, outcomeIndex: 0 }, 0), -0.4));

  assert("pnl: sell YES, YES wins -> -0.60",
    near(tradePnl({ side: "SELL", price: 0.4, outcomeIndex: 0 }, 1), -0.6));
  assert("pnl: sell YES, NO wins -> +0.40",
    near(tradePnl({ side: "SELL", price: 0.4, outcomeIndex: 0 }, 0), 0.4));

  // THE SIDE TRAP. Buying the NO token at 0.60 is a bet against YES, so
  // it must profit when YES loses.
  assert("pnl: buy NO, NO wins -> +0.40",
    near(tradePnl({ side: "BUY", price: 0.6, outcomeIndex: 1 }, 0), 0.4));
  assert("pnl: buy NO, YES wins -> -0.60",
    near(tradePnl({ side: "BUY", price: 0.6, outcomeIndex: 1 }, 1), -0.6));
  assert("pnl: sell NO, YES wins -> +0.60",
    near(tradePnl({ side: "SELL", price: 0.6, outcomeIndex: 1 }, 1), 0.6));
  assert("pnl: sell NO, NO wins -> -0.40",
    near(tradePnl({ side: "SELL", price: 0.6, outcomeIndex: 1 }, 0), -0.4));

  // Buying NO at q and selling YES at (1-q) are the same bet and must
  // pay the same. If the side handling is wrong this breaks.
  const buyNo = tradePnl({ side: "BUY", price: 0.6, outcomeIndex: 1 }, 0);
  const sellYes = tradePnl({ side: "SELL", price: 0.4, outcomeIndex: 0 }, 0);
  assert("pnl: buying NO at q equals selling YES at 1-q", near(buyNo, sellYes),
    `buyNo=${buyNo} sellYes=${sellYes}`);

  assert("pnl: the equivalence holds when the bet loses",
    near(tradePnl({ side: "BUY", price: 0.6, outcomeIndex: 1 }, 1),
         tradePnl({ side: "SELL", price: 0.4, outcomeIndex: 0 }, 1)));
}

// A fair bet at the market price wins nothing on average — that is what
// makes zero the baseline rather than an arbitrary reference.
{
  const p = 0.3;
  const win = tradePnl({ side: "BUY", price: p, outcomeIndex: 0 }, 1);
  const lose = tradePnl({ side: "BUY", price: p, outcomeIndex: 0 }, 0);
  assert("pnl: expectation at the market price is zero",
    near(p * win + (1 - p) * lose, 0));
  assert("pnl: the market baseline is zero", MARKET_BASELINE_PNL === 0);
}

// ─── Rejections ─────────────────────────────────────────────────────────
{
  assert("pnl: a price of 0 is rejected",
    tradePnl({ side: "BUY", price: 0, outcomeIndex: 0 }, 1) === null);
  assert("pnl: a price of 1 is rejected",
    tradePnl({ side: "BUY", price: 1, outcomeIndex: 0 }, 1) === null);
  assert("pnl: an unknown side is rejected",
    tradePnl({ side: "MINT", price: 0.5, outcomeIndex: 0 }, 1) === null);
  assert("pnl: a missing outcome index is rejected",
    tradePnl({ side: "BUY", price: 0.5 }, 1) === null);
  assert("pnl: a third outcome index is rejected",
    tradePnl({ side: "BUY", price: 0.5, outcomeIndex: 2 }, 1) === null);
  assert("pnl: an unresolved market is rejected",
    tradePnl({ side: "BUY", price: 0.5, outcomeIndex: 0 }, null) === null);
}

// ─── Wallet score ───────────────────────────────────────────────────────
{
  const t = (pnl, marketId, cluster) => ({ pnl, marketId, cluster, wallet: "w" });
  const s = scoreWallet([t(0.1, "m1", "e1"), t(-0.1, "m2", "e1"), t(0.3, "m3", "e2")]);
  assert("score: mean computed", near(s.meanPnl, 0.1, 1e-9));
  assert("score: trades counted", s.n === 3);
  assert("score: distinct markets counted", s.markets === 3);
  assert("score: distinct events counted separately from markets", s.events === 2);
  assert("score: win rate computed", near(s.winRate, 2 / 3, 1e-9));

  const noisy = scoreWallet([t(0.5, "a", "e1"), t(-0.4, "b", "e2"), t(0.5, "c", "e3")]);
  const steady = scoreWallet(Array.from({ length: 60 },
    (_, i) => t(0.05 + (i % 2 ? 0.01 : -0.01), "m" + i, "e" + i)));
  assert("score: a steady small edge outranks a noisy large one on t",
    steady.tStat > noisy.tStat, `steady=${steady.tStat.toFixed(2)} noisy=${noisy.tStat.toFixed(2)}`);

  assert("score: empty input yields nothing", scoreWallet([]) === null);
  assert("score: non-finite pnls are ignored",
    scoreWallet([{ pnl: NaN, marketId: "m", cluster: "e" }]) === null);
}

// ─── The look-ahead guard ───────────────────────────────────────────────
{
  const CUT = 1000;
  const trades = [
    ...Array.from({ length: 12 }, (_, i) => ({
      wallet: "good", pnl: 0.1, resolvedAt: 500 + i, marketId: "m" + i, cluster: "e" + i,
    })),
    // After the cutoff: enormous profits that must NOT enter the score.
    ...Array.from({ length: 12 }, (_, i) => ({
      wallet: "good", pnl: 5.0, resolvedAt: 2000 + i, marketId: "n" + i, cluster: "f" + i,
    })),
  ];
  const scores = scoreWalletsBefore(trades, CUT);
  assert("lookahead: the wallet is scored", scores.has("good"));
  assert("lookahead: only pre-cutoff trades count", scores.get("good").n === 12,
    `n=${scores.get("good").n}`);
  assert("lookahead: post-cutoff profits do not inflate the score",
    near(scores.get("good").meanPnl, 0.1, 1e-9),
    `mean=${scores.get("good").meanPnl}`);

  const future = scoreWalletsBefore([
    ...Array.from({ length: 20 }, (_, i) => ({
      wallet: "later", pnl: 0.5, resolvedAt: 5000 + i, marketId: "m" + i, cluster: "e" + i,
    })),
  ], CUT);
  assert("lookahead: a wallet with no history before the cutoff is unscored",
    future.size === 0);
}

// ─── Minimum track record ───────────────────────────────────────────────
{
  const CUT = 1000;
  const few = Array.from({ length: 4 }, (_, i) => ({
    wallet: "thin", pnl: 0.9, resolvedAt: 100 + i, marketId: "m" + i, cluster: "e" + i,
  }));
  assert("threshold: too few trades means no score",
    scoreWalletsBefore(few, CUT).size === 0);

  const oneEvent = Array.from({ length: 20 }, (_, i) => ({
    wallet: "narrow", pnl: 0.9, resolvedAt: 100 + i, marketId: "m" + i, cluster: "sameEvent",
  }));
  assert("threshold: many trades in one event is not a track record",
    scoreWalletsBefore(oneEvent, CUT).size === 0);

  const spread = Array.from({ length: 20 }, (_, i) => ({
    wallet: "broad", pnl: 0.9, resolvedAt: 100 + i, marketId: "m" + i, cluster: "e" + (i % 5),
  }));
  assert("threshold: trades across several events do qualify",
    scoreWalletsBefore(spread, CUT).size === 1);
}

// ─── Deciles ────────────────────────────────────────────────────────────
{
  const scores = new Map();
  for (let i = 0; i < 100; i++) {
    scores.set("w" + i, { n: 20, markets: 20, events: 5, meanPnl: i / 100, sd: 1, tStat: 1, winRate: 0.5, totalPnl: 1 });
  }
  const { deciles, ordered } = decileByScore(scores);
  assert("deciles: ten buckets", deciles.size === 10);
  assert("deciles: ascending order", ordered[0].meanPnl < ordered[ordered.length - 1].meanPnl);
  assert("deciles: bottom decile holds the worst",
    Math.max(...deciles.get(0).map(x => x.meanPnl)) <
    Math.min(...deciles.get(9).map(x => x.meanPnl)));
  assert("deciles: every wallet is placed",
    [...deciles.values()].reduce((s, a) => s + a.length, 0) === 100);
  assert("deciles: empty input is safe", decileByScore(new Map()).ordered.length === 0);
}

// ─── Independence ───────────────────────────────────────────────────────
{
  const trades = [];
  for (let i = 0; i < 10; i++) {
    for (const w of ["twinA", "twinB"]) {
      trades.push({ wallet: w, marketId: "m" + i, outcomeIndex: 0, side: "BUY" });
    }
    trades.push({ wallet: "solo", marketId: "s" + i, outcomeIndex: 0, side: "BUY" });
  }
  const pairs = overlapMatrix(trades, new Set(["twinA", "twinB", "solo"]));
  assert("overlap: the identical pair is found", pairs.length >= 1);
  assert("overlap: their similarity is total", near(pairs[0].jaccard, 1, 1e-9),
    `jaccard=${pairs[0]?.jaccard}`);
  assert("overlap: the independent wallet is not paired with them",
    !pairs.some(p => p.a === "solo" || p.b === "solo"));
}

const passed = results.filter(r => r.pass).length;
console.log("");
console.log("═══════════════════════════════════════════════════");
console.log(`  Wallet scoring tests: ${passed}/${results.length} passed`);
console.log("═══════════════════════════════════════════════════");
if (passed !== results.length) process.exit(1);
