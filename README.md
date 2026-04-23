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
- Uses the live runtime flow with paper-safe execution responses
- Best default for local validation, integration checks, and workflow testing

Run:

```bash
npm run live:paper
```

### Live mode

- Can place **real orders with real funds**
- Requires live credentials and careful risk configuration
- Uses Polymarket CLOB + wallet integration

Run:

```bash
npm run install:live
npm run live
```

Before running live mode, configure `.env` from `config-examples/.env.example`.

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

- mode and kill switch (`TRADING_MODE`, `KILL_SWITCH`, `KILL_SWITCH_FILE`)
- exchange and wallet (`PRIVATE_KEY`, `FUNDER_ADDRESS`, `SIGNATURE_TYPE`, CLOB credentials)
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
- Compatibility adapters remain intentionally for safe rollout and backward compatibility:
  - `src/live/config.js`
  - `src/live/logger.js`
  - `src/live/liveExecution.js`
  - `src/live/liveRisk.js`
  - `src/live/liveSignals.js`

## Safety and Disclaimer

- **Paper mode** is for testing/research and does not execute real orders.
- **Live mode** may place real orders on Polymarket and can result in financial loss.
- This repository is provided for engineering/research purposes and is **not financial advice**.
- You are responsible for secure credential handling, environment configuration, risk limits, and runtime supervision.

## License

MIT
