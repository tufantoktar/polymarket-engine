# Phase 3 — Data Collection & Backtesting (V5.8)

Purpose: validate that the production alpha pipeline (momentum + orderflow)
produces a real edge on **real market data** before any live capital is
deployed. The backtest replays recorded orderbooks through the *unmodified*
`SignalEngine` — the exact same code path the live event loop uses.

```
collect.js ──▶ NDJSON recordings ──▶ backtest.js
 (public          data/recordings/       │
  Gamma/CLOB       books-YYYYMMDD-HH      ├─ SignalEngine (production)
  endpoints,       .ndjson                ├─ depth-aware fill model
  no auth)                                ├─ portfolio accounting
                                          └─ metrics report
```

## 1. Collect data

Read-only. No SDK, no keys, no orders. Safe to leave running for days.

```bash
npm run collect                                    # 10s ticks, top 20 tokens
npm run collect -- --interval=5 --tokens=30        # denser
npm run collect -- --minutes=1440                  # auto-stop after 24h
npm run collect -- --dir=data/recordings/week1 --trades
```

One polling round = one `tick` event; the backtester makes exactly one
decision per tick, mirroring the live loop. Files rotate hourly and are
append-only NDJSON — safe to `gzip` old files in place, the replayer reads
`.ndjson.gz` transparently.

Recommended minimum before drawing any conclusion: **1–2 weeks** of
recording at 10s intervals across 20+ tokens.

## 2. Run a backtest

```bash
npm run backtest -- --data=data/recordings/week1
npm run backtest -- --data=data/recordings/week1 --equity=1000 \
    --max-slippage=0.02 --fee-bps=0 --report=reports/week1.json
```

Flags: `--equity` (default 1000), `--warmup` (ticks before first decision,
default 30), `--cooldown` (seconds between fills on same token+side,
default 60), `--max-slippage` (fraction of mid, default 0.02), `--fee-bps`.

The report includes total return, max drawdown, annualized Sharpe (from
per-tick returns — directional, not gospel at sparse intervals), hit rate,
profit factor, average slippage in bps, and full trade log (with
`--report`).

## 3. Reading results honestly

The fill model is **taker-only against recorded depth**: BUY walks recorded
asks, SELL walks recorded bids, slippage capped at `--max-slippage` vs mid.
It does **not** model maker fills/queue position, our own market impact, or
adverse selection between snapshots. Results are therefore an **upper
bound** on realizable edge:

- Negative or flat backtest PnL → the strategy has no edge; do not go live.
- Positive backtest PnL → *necessary but not sufficient*; proceed to a
  small-capital paper/live pilot and compare realized slippage + hit rate
  against the backtest before scaling.

Semantics (mirrors live long-only mapping): `BUY_YES` opens/extends a YES
position at asks; `BUY_NO` reduces an existing YES position at bids and is
skipped (counted as `skippedNoPosition`) when flat.

## 4. Kelly sizing fix (found by this infrastructure)

First synthetic replay exposed a sizing bug present since V4.2: `processSigs`
plugged the composite edge `ae` (typically 0.006–0.15) into the Kelly
formula **as if it were a win probability**, and inverted the odds term
(`px/(1-px)` instead of net odds `(1-px)/px`). Net effect: for
momentum/orderflow signals, position size clamped to 0 on all but
extreme-priced markets — the live signal path could effectively never
place an order.

V5.8 fix in `src/engine/alpha.js`: win probability `p = sidePrice + ae`,
net odds `b = (1 - sidePrice) / sidePrice`, half-Kelly
`f = 0.5 · (p·b − (1−p)) / b`, still capped by `regimeKellyCap` and scaled
by composite confidence. All 347 pre-existing tests remain green.

## 5. Tests

```bash
npm run test:backtest    # 47 tests: recorder, replay, fills, portfolio, metrics, e2e determinism
npm run test:all         # full suite (394 tests)
```

The e2e test writes a synthetic trending recording, replays it through the
production pipeline twice, and asserts fills occur and results are
byte-identical across runs (determinism).
