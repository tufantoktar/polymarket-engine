# Polymarket Engine

A modular Polymarket trading repository with two primary tracks:

- a **live runtime** under `src/live/` for paper or real-market execution
- a **core engine/simulator codebase** under `src/engine/` (plus legacy UI artifacts) for research and deterministic testing

This repository is no longer a single-file-only project. The current source of truth for live trading operations is the modular `src/live/` runtime.

## Overview

The live runtime is built around an orchestrated event loop with explicit module boundaries for:

- market discovery and book ingestion
- signal generation
- order execution and lifecycle state
- risk gates and kill switch controls
- startup recovery and periodic reconciliation
- snapshot persistence and operational alerts

The project supports both simulation-like paper execution and real exchange execution against Polymarket CLOB.

## Modes

### Paper mode

- No private key required
- Does **not** require `ENABLE_LIVE_TRADING=true`
- Does **not** require V2 collateral/wrap configuration
- Does **not** require the V2 SDK (`@polymarket/clob-client-v2`) to be installed
- Uses the live runtime flow with paper-safe, simulated execution responses
- Every placement response is marked `paper:true` and `clobVersion:"v2"`
- Best default for local validation, integration checks, and workflow testing
- **Mandatory first validation step before any live test** (Phase 2)

Run:

```bash
npm run live:paper
```

Targeted paper-mode validation suites (added in Phase 2):

```bash
npm run test:paper:v2        # paper isolation against the V2 path
npm run test:paper:runtime   # bounded EventLoop tick validator
npm run test:paper           # both, in sequence
```

### Live mode

- Can place **real orders with real funds**
- Requires live credentials and careful risk configuration
- Uses Polymarket **CLOB V2** + wallet integration (Phase 1, V5.7+)
- **Refuses to start unless `ENABLE_LIVE_TRADING=true` is explicitly set**

Run:

```bash
npm run install:live    # installs @polymarket/clob-client-v2 and ethers v5
npm run live
```

Before running live mode, configure `.env` from `config-examples/.env.example`. The runtime executes a fast preflight that fails if any of the following is wrong: `ENABLE_LIVE_TRADING` is not true, `POLYMARKET_CLOB_VERSION` is not `v2`, `PRIVATE_KEY` is missing, the kill switch is active, the V2 SDK can't load, or required collateral wrap config is missing while wrap is enabled.

## Architecture

### Live runtime (`src/live/`)

Canonical module entrypoints:

- `src/live/config/index.js`
- `src/live/logging/index.js`
- `src/live/execution_engine/index.js`
- `src/live/risk_engine/index.js`
- `src/live/signal_engine/index.js`
- `src/live/market_scanner/index.js`
- `src/live/portfolio_state/index.js`

Core runtime modules:

- `eventLoop.js`: orchestrates lifecycle and tick flow
- `execution_engine/`: order placement, cancel/status, fills, dedupe integration
- `risk_engine/`: risk limits and halt behavior
- `monitoring/`: kill switch, health, observability, alerts
- `sync/`: startup recovery and exchange reconciliation
- `state/`: order/position stores, FSM, deduper, snapshots
- `polymarketClient.js` + `wallet.js`: exchange and wallet access

Detailed module governance: [src/live/ARCHITECTURE.md](src/live/ARCHITECTURE.md)

### Shared engine modules (`src/engine/`)

`src/engine/` contains deterministic core logic used by simulator/research flows (history/regime/alpha/risk/execution/portfolio/tick/system primitives).

## Repository Structure

```text
src/
  live/                     # modular live trading runtime (current source of truth for live ops)
  engine/                   # shared deterministic engine modules
  tests/                    # deterministic test harness
  App.jsx                   # legacy simulator/UI artifact
scripts/
  runLive.js                # live/paper runtime entry script
  test*.js                  # state, execution, reliability, hardening checks
config-examples/
  .env.example              # live/paper environment template
logs/                       # runtime logs and snapshots
```

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Copy environment template:

```bash
cp config-examples/.env.example .env
```

3. Start paper mode:

```bash
npm run live:paper
```

4. Optional UI dev server (legacy simulator/research artifact):

```bash
npm run dev
```

## Running Live Mode Safely

1. Fill required live vars in `.env` (at minimum `TRADING_MODE=live` and `PRIVATE_KEY`; `FUNDER_ADDRESS` required for signature type `1` or `2`).
2. Ensure optional live dependencies are installed:

```bash
npm run install:live
```

3. Start live runtime:

```bash
npm run live
```

4. Inspect trade logs:

```bash
npm run trades
```

Operational checklist: [docs/LIVE_RUNBOOK.md](docs/LIVE_RUNBOOK.md)

## Configuration

Main runtime configuration is defined in `src/live/config/index.js` and mapped to environment variables.

Start with:

- `config-examples/.env.example`

High-impact configuration groups:

- mode and kill switch (`TRADING_MODE`, `ENABLE_LIVE_TRADING`, `KILL_SWITCH`, `KILL_SWITCH_FILE`)
- CLOB version selector (`POLYMARKET_CLOB_VERSION` — Phase 1 targets `v2`)
- exchange and wallet (`PRIVATE_KEY`, `FUNDER_ADDRESS`, `SIGNATURE_TYPE`, `BUILDER_ADDRESS`, `POLYMARKET_CHAIN`/`CHAIN_ID`, CLOB credentials)
- collateral / wrap (`ENABLE_COLLATERAL_WRAP`, `COLLATERAL_TOKEN_ADDRESS`, `COLLATERAL_ONRAMP_ADDRESS`)
- risk limits (`MAX_ORDER_QTY`, `MAX_ORDER_NOTIONAL`, `MAX_POSITION_PER_MARKET`, `MAX_DAILY_LOSS`, etc.)
- loop cadence (`TICK_INTERVAL_MS`, market/book refresh intervals)
- reliability controls (recovery, reconciliation, monitoring, snapshot, alert thresholds)

## Tests and Checks

Primary commands:

```bash
npm run test:state
npm run test:exec
npm run test:reliability
npm run test:hardening
npm run test:all
```

Architecture drift guard:

```bash
npm run check:live-imports
```

This check blocks internal imports from reverting to compatibility adapter paths.

## Current Status

- Phase 2 modular live runtime is in place under `src/live/`.
- Phase 2.1 governance guardrails are added:
  - architecture documentation
  - adapter-import regression check
- **Phase 1 CLOB V2 migration (V5.7.0)**: live trading targets Polymarket
  CLOB V2 via `@polymarket/clob-client-v2`. V1 client/signature assumptions
  (`nonce`/`feeRateBps`/`taker`) are no longer valid. V2 order construction
  lives in a small, testable helper at `src/live/execution/v2OrderBuilder.js`
  and is fully unit-covered (`npm run test:v2`). Live mode requires explicit
  `ENABLE_LIVE_TRADING=true` and a passing preflight before any orders flow.
- **Phase 3 data collection & backtesting (V5.8.0)**: `npm run collect`
  records real orderbooks (public endpoints only, no auth/orders) to
  NDJSON; `npm run backtest` replays them through the **unmodified
  production `SignalEngine`** with a depth-aware taker fill model and
  produces a full performance report (return, drawdown, Sharpe, hit rate,
  slippage). The first synthetic replay exposed and fixed a Kelly sizing
  bug present since V4.2 that clamped momentum/orderflow position sizes
  to 0 on non-extreme-priced markets. See `docs/BACKTESTING.md`.
  Covered by `npm run test:backtest` (47 tests, incl. e2e determinism).
  A positive backtest is the gate — necessary but not sufficient —
  before any live capital.
- **Phase 2 paper mode V2 validation (V5.7.1)**: validation/test/doc
  hardening proving the V2 migration didn't break paper mode. Paper
  mode is provably isolated from the V2 live path: `PolymarketClient`
  in paper never instantiates the V2 client, `LiveExecutionEngine`
  round-trips paper orders through the FSM into `ORDER_PLACED` without
  touching live, the `EventLoop` runs ticks end-to-end against a stubbed
  client without network, and the live preflight remains strict.
  Covered by `npm run test:paper:v2` (33 tests) and
  `npm run test:paper:runtime` (10 tests). Phase 2 does **not** prove
  live order placement — that belongs to a later controlled live dry-run
  phase.
- Compatibility adapters remain intentionally for safe rollout and backward compatibility:
  - `src/live/config.js`
  - `src/live/logger.js`
  - `src/live/liveExecution.js`
  - `src/live/liveRisk.js`
  - `src/live/liveSignals.js`

## Safety and Disclaimer

- **Paper mode** is safe and does not place real orders. It does not require a private key.
- **Live mode** may place real orders on Polymarket CLOB V2 and **can lose money**.
- Live mode is gated by `ENABLE_LIVE_TRADING=true`; the runtime refuses to start otherwise.
- V2 collateral/wrap configuration must be checked before live use. Funds are never auto-wrapped unless `ENABLE_COLLATERAL_WRAP=true`.
- Phase 1 targets CLOB V2 only. **V1 client/signature assumptions (nonce / feeRateBps / taker) are no longer valid.**
- This repository is provided for engineering/research purposes and is **not financial advice**.
- You are responsible for secure credential handling, environment configuration, risk limits, and runtime supervision.

## License

MIT
