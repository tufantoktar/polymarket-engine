# Polymarket Trading Engine V4.3.1

A deterministic, single-file quantitative trading engine simulator for prediction markets. Built as a React artifact with a pure functional engine core and a render-only UI layer.

## What It Does

Simulates a complete automated trading pipeline for Polymarket-style binary prediction markets:

- **Signal Generation** — NLP (news sentiment), Momentum (technical indicators), Statistical Arbitrage (pair correlations)
- **Meta-Alpha** — Learns from realized PnL to dynamically weight signal sources
- **Risk Management** — Position limits, exposure caps, drawdown scaling, category caps, liquidity filters
- **Order Execution** — 7-state FSM (NEW→ACCEPTED→PARTIALLY_FILLED→FILLED|CANCELLED|REJECTED|REPLACED)
- **Partial Fill Handling** — RETRY / REPLACE / UNWIND / CANCEL with deterministic lineage
- **Circuit Breaker** — 3-state FSM (closed→open→half_open) with 6 config-driven triggers
- **Reconciliation** — Fill-based position rebuild every tick, drift detection and auto-correction
- **Fill-Level Attribution** — Realized PnL attributed via actual fill→order→signal lineage

## Architecture

```
┌─────────────────────────────────────────────┐
│  ENGINE (pure functions, no side effects)    │
│                                             │
│  Market Sim → Signals → Risk → Execution    │
│  → Fills → Positions → Reconciliation       │
│  → Circuit Breaker → MetaAlpha Attribution  │
├─────────────────────────────────────────────┤
│  UI (render-only, no state mutation)         │
│                                             │
│  Dashboard · Regime · Alpha · Execution     │
│  · Risk · System · Tests                    │
└─────────────────────────────────────────────┘
```

Single file: `src/App.jsx` — engine + UI in one file by design.

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:5173` and click **START**.

## Tabs

| Tab | Shows |
|-----|-------|
| **Dashboard** | Equity curve, markets, P&L, exposure |
| **Regime** | Trend/vol/liquidity detection, meta-alpha weights |
| **Alpha** | News feed, active signals, recommendations |
| **Execution** | Order FSM states, child fills, partial actions |
| **Risk** | Pre-trade risk verdicts, position ledger |
| **System** | Reconciliation, CB triggers, events, counters |
| **Tests** | 32 deterministic correctness tests |

## Version History

### V4.3.2 — Correctness + Clarity Patch
- Half-open CB cap now true NOTIONAL (converted to qty via side price)
- Half-open probe accounting uses real fill notional (qty × price)
- Sizing from live state: equity, DD, remaining notional/position/category room
- Pruning rewritten: flat-array return, transitive lineage closure, bounded iteration
- Risk clarity: explicit names (requestedQty/allowedQty/sidePrice/additionalNotional)
- Attribution hardened against null/array/NaN/Infinity attr
- 12 new tests (115 total, all passing)

### V4.3.1 — Meta-Alpha Attribution Correctness
- Fill-level source lineage (`fill.attr` from originating order)
- Realized PnL attributed per-fill via actual lineage
- Removed "most recent order in market" .pop() bug
- Partial close attribution (only closing portion attributed)
- `applyAttributionEvents` is pure and deterministic
- No unrealized PnL learning, no fill-quality proxy learning
- 9 new attribution tests (Tests 24-32)

### V4.3 — Correctness + Determinism + Lifecycle Hardening
- Terminal state immutability (FILLED/CANCELLED/REJECTED/REPLACED)
- Deterministic order IDs with tick-local sequence counter
- Child-level fill key dedup
- Pure circuit breaker functions (no mutation)
- Windowed reject tracking (was unbounded counter)
- Poor fill evaluation timing fix
- Spawn depth/count enforcement, deferred spawn dedup
- History pruning with transitive lineage protection

### V4.2 — Circuit Breaker + Risk + Exposure Consistency
- Full 3-state CB FSM with 6 triggers
- Notional vs quantity exposure separation
- Windowed slippage/poor fill/invalid data tracking
- Poor fills and invalid market data now actually trip CB

## Determinism Guarantees

Same `seed` + same `tickTime` + same event sequence = identical output.

- PRNG: seeded, deterministic per tick
- Order IDs: tick-local sequence counter
- Fill timestamps: injected `tickTime` only
- Attribution: pure `(metaPerf, attrEvents) → metaPerf`
- No hidden mutation, no wall-clock dependencies in engine

## Tests

Click the **Tests** tab to run 32 deterministic tests covering:

- Order lifecycle FSM transitions
- Partial fill actions (retry/replace/unwind/cancel)
- Duplicate fill rejection
- Position + PnL rebuild from fills
- Reconciliation consistency
- Circuit breaker triggers + recovery
- Fill-level attribution correctness
- Partial close attribution
- Deterministic replay verification

## Tech Stack

- React 18 + Vite
- Zero external dependencies (engine is pure JS)
- Tailwind-free: all styles are inline objects
- Monospace: JetBrains Mono / Fira Code

## License

MIT

## Disclaimer

This is a simulation engine for educational and research purposes. It does not execute real trades, connect to real markets, or provide financial advice.
