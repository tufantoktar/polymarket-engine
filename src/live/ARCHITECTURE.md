# Live Engine Architecture

## 1. Overview

`src/live/` is the modular runtime for continuous Polymarket trading operations.

It supports two execution modes:

- **Paper mode**: runs the same runtime pipeline but does not submit real exchange orders.
- **Live mode**: runs against real Polymarket infrastructure and may submit real orders.

`eventLoop.js` is the top-level orchestrator. It coordinates module calls, lifecycle, guards, and scheduling. It should not own strategy/business logic.

## 2. High-Level Flow

```text
EventLoop
  -> MarketScanner
  -> SignalEngine
  -> PortfolioState
  -> RiskEngine
  -> ExecutionEngine
  -> State Stores
  -> Monitoring / KillSwitch / Observability
  -> Logging / Snapshot
```

Runtime flow per tick is controlled by EventLoop and composed from module interfaces.

## 3. Module Ownership

- `config/`:
  - Runtime config defaults + env mapping
  - Validation
  - Kill-switch sentinel checks

- `logging/`:
  - Structured JSONL logging
  - Decision/trade/error channels

- `execution_engine/`:
  - Order lifecycle execution surface
  - Order FSM transitions via state modules
  - Placement, cancel, status refresh, fill application

- `risk_engine/`:
  - Trading limits
  - Session/day-level risk tracking
  - Halt logic and risk rejections

- `signal_engine/`:
  - Ingest normalized market data
  - Generate recommendations from engine signals

- `market_scanner/`:
  - Discover tradable markets/tokens
  - Pull orderbooks
  - Map recommendations into order requests

- `portfolio_state/`:
  - Build live portfolio state snapshot used by signal generation

- `monitoring/`:
  - Kill switch triggers and halt state
  - Health snapshots
  - Observability counters/flags
  - Operator alerts

- `state/`:
  - `orderStore`
  - `positionStore`
  - `signalDeduper`
  - `snapshot` persistence helpers
  - `orderStateMachine` for explicit transitions

- `sync/`:
  - Startup recovery
  - Periodic reconciliation against exchange truth

## 4. EventLoop Responsibilities

EventLoop responsibilities:

- orchestration only
- lifecycle coordination
- scheduling and guard checks
- cross-module wiring

EventLoop non-responsibilities:

- no embedded order execution logic
- no embedded risk rule implementation
- no direct state mutation bypassing module interfaces

Tick lifecycle (simplified):

1. Evaluate startup/recovery state.
2. Evaluate kill-switch and risk guards.
3. Run periodic reconciliation when due.
4. Refresh active tradable tokens.
5. Ingest orderbook data.
6. Run execution housekeeping (stale orders, sync cadence).
7. Build live portfolio state.
8. Generate signal recommendations.
9. Convert recommendations to orders and send through execution engine.
10. Emit summary/health/observability logs and snapshots.

## 5. Data Flow

```text
Market Data (Gamma/CLOB)
  -> MarketScanner (token + book ingest)
  -> SignalEngine (recommendations)
  -> ExecutionEngine (order intents -> order lifecycle)
  -> Fills / Status Updates
  -> PositionStore + OrderStore
  -> Risk + Health + Observability metrics
  -> Logs + Snapshot persistence
```

Primary state movement:

- market data -> signals
- signals -> order requests
- order requests -> order state transitions
- fills -> positions + realized metrics
- state + metrics -> monitoring + logs

## 6. Compatibility Adapters

The following files exist only for backward compatibility:

- `src/live/config.js`
- `src/live/logger.js`
- `src/live/liveExecution.js`
- `src/live/liveRisk.js`
- `src/live/liveSignals.js`

These are **temporary compatibility adapters**.

Internal runtime code should treat them as legacy shims, not primary dependencies.

## 7. Import Rules (Mandatory)

Internal imports must use canonical module entrypoints, for example:

- `src/live/config/index.js`
- `src/live/logging/index.js`
- `src/live/execution_engine/index.js`
- `src/live/risk_engine/index.js`
- `src/live/signal_engine/index.js`
- `src/live/market_scanner/index.js`
- `src/live/portfolio_state/index.js`

Do not import adapter files from internal runtime code or runtime scripts.

Disallowed internal targets:

- `src/live/config.js`
- `src/live/logger.js`
- `src/live/liveExecution.js`
- `src/live/liveRisk.js`
- `src/live/liveSignals.js`

## 8. Design Principles

- **Modular boundaries**: each module has a clear ownership surface.
- **Deterministic where possible**: avoid hidden mutation and implicit side effects.
- **Explicit state transitions**: order lifecycle changes go through FSM/state modules.
- **Observability-first**: decisions, errors, health, and alerts are first-class outputs.
- **Safety-first**: risk limits, kill switch, recovery, and reconciliation are core runtime controls.
