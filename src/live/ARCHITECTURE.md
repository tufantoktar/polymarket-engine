# Live Engine Architecture (Phase 2.1)

## Purpose
`src/live/` contains the production live trading runtime for Polymarket.
It is responsible for orchestration, signal generation, risk gates, execution, monitoring, reconciliation, startup recovery, and runtime state persistence.

## Canonical Entrypoints
The following modules are canonical entrypoints for internal runtime imports:

- `src/live/config/index.js`
- `src/live/logging/index.js`
- `src/live/execution_engine/index.js`
- `src/live/risk_engine/index.js`
- `src/live/signal_engine/index.js`
- `src/live/market_scanner/index.js`
- `src/live/portfolio_state/index.js`

## Module Ownership
- `config/index.js`: live runtime configuration, env parsing, validation, kill-switch file/env check.
- `logging/index.js`: structured logging surface used by runtime modules.
- `eventLoop.js`: orchestration layer for tick lifecycle and runtime coordination.
- `execution_engine/index.js`: order lifecycle, placement/cancel/status, fills, dedupe integration.
- `risk_engine/index.js`: pre-trade and session risk controls.
- `signal_engine/index.js`: market-data ingestion and recommendation generation.
- `market_scanner/index.js`: tradable token discovery, book ingestion, recommendation-to-order mapping.
- `portfolio_state/index.js`: live portfolio snapshot assembly for signal engine input.
- `monitoring/*`: kill switch, health, observability, alerting.
- `sync/*`: startup recovery and periodic reconciliation.
- `state/*`: runtime state stores and state-machine primitives.

## Compatibility Adapters (Intentional)
The following files are compatibility adapters and remain intentionally for backward compatibility:

- `src/live/config.js`
- `src/live/logger.js`
- `src/live/liveExecution.js`
- `src/live/liveRisk.js`
- `src/live/liveSignals.js`

These files are not canonical internal dependencies.

## Import Rule
Internal runtime code (`src/live/**`) and runtime scripts (`scripts/**`) must import canonical entrypoints, not adapter files.

Allowed (canonical):
- `from "./config/index.js"`
- `from "./logging/index.js"`
- `from "./execution_engine/index.js"`
- `from "./risk_engine/index.js"`

Disallowed (adapter path usage in internal code):
- `from "./config.js"`
- `from "./logger.js"`
- `from "./liveExecution.js"`
- `from "./liveRisk.js"`
- `from "./liveSignals.js"`

## Adapter Deprecation Note
Adapters remain in place for a safe rollout window to avoid breaking external integrations.
After one stable release cycle with no adapter usage in internal code, adapters can be scheduled for removal.

## Event Loop Runtime Flow
`eventLoop.js` orchestrates the runtime in this order:

1. Initialize execution engine and approvals (mode-dependent).
2. Load snapshot (if enabled) and run startup recovery.
3. Optionally run initial reconciliation.
4. Start continuous ticks.
5. Per tick: evaluate kill-switch/risk guards, run scheduled reconciliation, refresh markets, ingest orderbooks, run housekeeping, build live state, generate recommendations, place orders via execution engine, emit health and decision summaries.
6. On shutdown signals: trigger halt path, cancel open orders, flush snapshot writer, and stop cleanly.
