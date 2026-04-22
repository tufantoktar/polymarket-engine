# Changelog

## [5.6.0] — Phase 2 Reliability Hardening

Minimal, additive reliability layer on top of V5.5. No architectural changes,
no strategy changes, no engine rewrite. Priority was: restart safety >
operator visibility > clean minimal code.

### Added
Three new modules, all isolated from strategy logic:

- `src/live/state/snapshot.js` — lightweight periodic state persistence
  - `buildSnapshot(sources)` — pure serializer from runtime stores
  - `writeSnapshotFile(path, data)` — atomic tmp+rename, never throws, returns `{ok, bytes | error}`
  - `loadSnapshotFileSync(path)` — tolerant of missing/empty/corrupt JSON + schema mismatch → returns `null`
  - `applySnapshot(snap, stores)` — best-effort per-section restore; primes `SignalDeduper` so a just-restored order can't be duplicated by a fresh signal
  - `SnapshotWriter` — interval-driven, `inFlight` guard prevents overlapping writes, `.unref()`'d timer, `flush()` for shutdown
  - JSON schema: `{schemaVersion, savedAt, orders:{open, recentTerminal}, positions, lastSignals, flags}`

- `src/live/monitoring/observability.js` — runtime flags for operators
  - `tradingBlocked / tradingBlockedReason / tradingBlockedSince`
  - `lastTradeTimestamp / noTradeDuration` (derived)
  - `repeatedDuplicateSignals / reconcileMismatchCount` (cumulative)
  - `lastDuplicateAt / lastReconcileAt / lastReconcileMismatchAt` breadcrumbs
  - Idempotent mutators, tolerant of bad inputs — safe for hot paths

- `src/live/monitoring/alerts.js` — operator warning conditions
  - 4 rules: `no_trades`, `recovery_pending`, `duplicate_spam`, `reconcile_drift`
  - De-dup: first activation always logs (state change), re-log only after `cooldownMs`
  - Clearing is explicit and logged as `alert:<key>:cleared` (info)
  - Active alert list + per-alert count + first/last fired timestamps
  - All thresholds configurable, all env-overridable

### Integration (minimal additive changes)
- `config.js` — new `snapshot.*` and `alerts.*` sections, all env-overridable, backward compatible
- `liveExecution.js` — accepts optional `observability` DI, calls `recordDuplicateSignal()` on dup paths, `recordFill()` on successful fills
- `eventLoop.js`:
  - Constructs `Observability + AlertEngine + SnapshotWriter`
  - On boot: `loadSnapshotFileSync()` + `applySnapshot()` BEFORE exchange recovery (snapshot gives warm resume; recovery is authority)
  - After boot reconcile: starts `SnapshotWriter.start()`
  - Tick guards call `setTradingBlocked/clearTradingBlocked`
  - Reconciliation summary feeds `observability.recordReconciliation()`
  - `alerts.evaluate()` runs each tick
  - `tick:summary` includes `observability` + `alerts.active`
  - SIGINT/SIGTERM: `snapshotWriter.flush()` before exit

### Config additions
```
snapshot.enabled                SNAPSHOT_ENABLED=true
snapshot.filePath               SNAPSHOT_FILE=./logs/runtime-snapshot.json
snapshot.intervalMs             SNAPSHOT_INTERVAL_MS=10000
snapshot.loadOnStart            SNAPSHOT_LOAD_ON_START=true

alerts.noTradeAlertMs           ALERT_NO_TRADE_MS=600000
alerts.recoveryPendingGraceMs   ALERT_RECOVERY_GRACE_MS=30000
alerts.duplicateSignalThreshold ALERT_DUP_SIGNAL_THRESHOLD=20
alerts.reconcileMismatchThreshold ALERT_RECONCILE_MISMATCH_THRESHOLD=5
alerts.cooldownMs               ALERT_COOLDOWN_MS=300000
```

### Validation
- **72/72 new hardening tests pass** (`scripts/testHardeningModules.js`)
  - snapshot: roundtrip, missing file, corrupt JSON, empty file, wrong schema, unexpected shape, write failure doesn't throw
  - observability: all flag updates, counter increments, derived fields, defensive nulls
  - alerts: each of the 4 triggers, cooldown suppresses re-log, cooldown expires, state-change re-fires within cooldown, clearing works
  - SnapshotWriter: interval + flush + stats
- **237 tests total** across V5.4+V5.5+V5.6 (64 state + 34 exec + 67 reliability + 72 hardening)
- **Regression check**: all 165 pre-V5.6 tests still green
- **End-to-end paper smoke**:
  - Snapshot file written (672 bytes) every `intervalMs`
  - `tick:summary` includes all 8 observability keys + alerts structure
  - SIGTERM fires `killSwitch:triggered manual_api` + flushes snapshot
- **Warm-resume round trip verified**: wrote fake snapshot with 1 open order + 1 position, started bot, confirmed `snapshot:applied ordersRestored:1 positionsRestored:1 dedupeKeysRestored:1`, `tick:summary` showed restored order + position

### Assumptions
- Exchange reconciliation remains the authority on order/position truth — snapshot is warm-resume optimization only
- Snapshot rarely conflicts with reconcile (both flow into the same stores; later writes win)
- Alert cooldown default 5 min is conservative; can tune via env
- `HealthMonitor._recoveryStatus` is read directly by AlertEngine — tolerable given both are private runtime helpers

### New npm scripts
```
npm run test:hardening     # 72 V5.6 hardening tests
npm run test:all           # full suite: state + exec + reliability + hardening (237 tests)
```

---

## [5.5.0] — Production Reliability

### Added
Five new modules that upgrade the bot from modular runtime to production-grade reliability. All build on top of the V5.4 state modules without breaking any boundaries.

- `src/live/execution/slippage.js` — pure book-walk VWAP + slippage/liquidity guard
  - `estimateExecutionPrice(book, side, size)` → `{estimatedPrice, filledSize, shortfall, levelsTouched}`
  - `computeSlippage(est, ref, side)` → signed bps (direction-aware)
  - `checkLiquidity(book, side)` → total USDC notional available
  - `evaluateSlippageAndLiquidity(args)` → full guard: `{allowed, estimatedPrice, referencePrice, slippage, availableLiquidity, levelsTouched, shortfall, reason}`

- `src/live/monitoring/killSwitch.js` — `KillSwitch` class with 5 auto-triggers
  - daily loss exceeds `config.risk.maxDailyLoss`
  - consecutive API errors exceed threshold
  - rolling API failure rate exceeds threshold
  - stuck orders (resting / partial past timeout without progress)
  - manual `.KILL` file or `KILL_SWITCH=1` env (V5.3 behavior preserved)
  - Halts are permanent for the session with structured reason objects
  - Records API success/failure + order progress events from liveExecution

- `src/live/sync/reconciliation.js` — `syncPositions(deps)` covers all 5 drift cases
  - Position present on exchange, missing locally → restore
  - Position present locally, absent on exchange → correct (zero out)
  - Partial fill drift between local and remote → update filledSize + avg
  - External open order missing internally → mark for review
  - Internal open order absent on exchange → transition via authoritative remote status
  - All mutations go through `orderStore.transition()` (FSM-safe) and `positionStore.set()`
  - Returns exact shape required by spec: `{timestamp, positionsRestored, positionsCorrected, ordersRestored, ordersCorrected, mismatches, errors}`

- `src/live/sync/startupRecovery.js` — `runStartupRecovery(deps)` restores state on boot
  - Walks exchange open orders → creates internal records via FSM `IDLE → SIGNAL_DETECTED → ORDER_PLACED [→ PARTIAL_FILL]`
  - Restores positions from wallet balance reads
  - Populates `SignalDeduper` with deterministic `source=recovered` signal keys so fresh post-boot signals cannot duplicate recovered orders
  - Feature-flagged via `config.recovery.enabled`
  - Event loop awaits this before first live tick

- `src/live/monitoring/health.js` — `HealthMonitor` read-only aggregator
  - `getHealthStatus({livePrices})` → full runtime status: running/halted/openOrders/openPositions/realizedPnl/unrealizedPnl/dailyPnl/apiFailureRate/consecutiveErrors/lastReconcileAt/recovery/...
  - `getSummaryLine()` → compact single-line CLI output
  - `recordTick/recordReconciliation/recordRecoveryStarted/recordRecoveryFinished` hooks

### Integration updates
- `src/live/liveExecution.js`
  - Step-0 kill-switch gate at top of `placeOrder` (fast reject when halted)
  - Step-3.5 slippage+liquidity guard after risk pass (live mode only)
  - `killSwitch.recordApiSuccess/Failure` on client.placeOrder try/catch
  - `killSwitch.recordOrderProgress/Terminal` on FSM transitions
  - `risk.recordRealizedPnl(delta)` on fills — feeds the daily-loss trigger
  - killSwitch added to `snapshot()`

- `src/live/eventLoop.js`
  - Constructs `KillSwitch` + `HealthMonitor` and injects killSwitch into `LiveExecutionEngine`
  - Awaits `runStartupRecovery` during `init()` — live trading blocked until done
  - Optional boot-time reconciliation (`reconciliation.runOnStart`)
  - Periodic `syncPositions` on `reconciliation.intervalMs`
  - Per tick: `killSwitch.evaluate(ctx)` gate with auto-cancel on first halt
  - Per tick: full health snapshot embedded in `tick:summary` log entry
  - SIGINT/SIGTERM handler now also calls `killSwitch.triggerManual()`

### Config additions (all env-overridable, backward compatible)
```
execution.maxSlippageBps        EXEC_MAX_SLIPPAGE_BPS=50
execution.minLiquidity          EXEC_MIN_LIQUIDITY=200
reconciliation.intervalMs       RECONCILIATION_INTERVAL_MS=30000
reconciliation.runOnStart       RECONCILIATION_RUN_ON_START=true
recovery.enabled                STARTUP_RECOVERY_ENABLED=true
recovery.timeoutMs              STARTUP_RECOVERY_TIMEOUT_MS=30000
monitoring.maxConsecutiveErrors MAX_CONSECUTIVE_ERRORS=5
monitoring.maxApiFailureRate    MAX_API_FAILURE_RATE=0.5
monitoring.apiWindowSize        API_WINDOW_SIZE=20
monitoring.stuckOrderTimeoutMs  STUCK_ORDER_TIMEOUT_MS=120000
monitoring.healthLogIntervalMs  HEALTH_LOG_INTERVAL_MS=15000
```

### Validation
- **67/67 new reliability tests pass** (`scripts/testReliabilityModules.js`)
  - slippage: book-walk VWAP, signed bps, liquidity check, all guard rejection paths
  - killSwitch: 5 triggers including stuck-order detection, sticky halt, manual trigger, snapshot shape
  - health: status composition, unrealized PnL via livePrices, recovery/reconcile tracking
  - reconciliation: order state correction, position restore, position zeroing, paper short-circuit
  - startupRecovery: order + position restore, deduper population, paper short-circuit, disabled flag
- **34/34 V5.4 execution-flow tests still pass** (no regression)
- **64/64 V5.4 state-module tests still pass**
- Paper-mode runtime smoke: boot → recovery → reconciliation → ticks with health snapshot → SIGTERM → `manual_api` kill-switch trigger → graceful cancelAll

### New npm scripts
```
npm run test:reliability    # 67 V5.5 reliability tests
npm run test:all            # state + execution + reliability (165 total)
```

### Remaining risks deferred to later phases
- Reconciliation relies on `getOrderStatus` for orders that disappear from `getOpenOrders`. If the exchange status endpoint is unreliable we may misclassify — a conservative fallback (query fills endpoint) is a future hardening.
- Cost-basis is not recovered on restart — local `avgEntryPrice` starts at 0 for positions the bot didn't open. Acceptable because PnL is realized per fill going forward.
- Unrealized PnL in `HealthMonitor` requires a `livePrices` map from the caller; a built-in price feed would be cleaner but adds coupling.

---

## [5.4.0] — State Module Extraction & Execution Hardening

### Added
Four new state modules under `src/live/state/` that establish clean domain boundaries for order lifecycle, storage, positions, and idempotency:

- `orderStateMachine.js` — strict FSM with explicit transitions
  - States: IDLE → SIGNAL_DETECTED → ORDER_PLACED → PARTIAL_FILL → FILLED / CANCELLED / FAILED
  - Terminal states protected; invalid transitions return structured failure (no throw, no silent mutation)
  - Every transition appends to order history for full auditability

- `orderStore.js` — in-memory order registry
  - Three indexes: orderId / signalKey / externalOrderId
  - Duplicate detection: rejects same signalKey while prior order is non-terminal
  - Atomic transitions through FSM only — no direct state mutation
  - Internal orderId is source of truth; externalOrderId mapped separately

- `positionStore.js` — position tracking with PnL
  - Per-tokenId records with qty, avgEntryPrice, realizedPnl, totalBuyQty, totalSellQty
  - Weighted-average entry price on successive BUYs
  - Realized PnL computed on SELL
  - `restorePositions()` for reconciliation against exchange snapshots
  - `getNetExposure()` returns gross + net notional

- `signalDeduper.js` — signal-level idempotency
  - Deterministic `buildSignalKey(signal)` with configurable timestamp bucketing (default 30s)
  - Bounded LRU cache (default 5000 entries) + TTL (default 5 min)
  - Prevents duplicate order submission when the same signal recurs across ticks

### Refactored
- `liveExecution.js` — drops the ad-hoc `Map<orderId, entry>` and `Map<tokenId, qty>` from V5.3:
  - All order state now in `OrderStore`
  - All position state now in `PositionStore`
  - All idempotency through `SignalDeduper`
  - New `applyFill()` method drives both FSM advance and position update
  - Every transition emits a structured `order:transition` decision log
  - Supports lookup by either internal or external order ID
- `eventLoop.js` — now a pure orchestrator:
  - Emits one `tick:summary` structured log per iteration with full state snapshot (signals, placements, orders, positions, risk)
  - Owns no lifecycle logic; delegates to `LiveExecutionEngine`
  - Builds deterministic `signalKey` per recommendation before handing to execution
  - Periodic `deduper.clearExpired()` housekeeping every 20 ticks

### Validation
- **64/64 state-module unit tests pass** (`scripts/testStateModules.js`)
- **34/34 execution-flow integration tests pass** (`scripts/testExecutionFlow.js`)
- All 52 engine tests from V5.2 still green
- Paper-mode runtime: boots → ticks → emits structured summaries → SIGTERM graceful shutdown
- Test coverage: FSM transitions, duplicate detection, LRU eviction, TTL expiration, weighted avg, realized PnL, partial fills, risk clamping, cancelAll

### Design principles
- No implicit mutation; all state transitions are explicit and logged
- No hidden shared mutable state; state owned by single module per concern
- Pure state-machine module; stores are thin wrappers around FSM + indexes
- Backward compatible: `placeOrder`, `cancelOrder`, `getOpenOrders`, `syncPositions`, `snapshot` surfaces preserved

### New scripts
```
scripts/
├── testStateModules.js     unit tests for FSM + stores + deduper
└── testExecutionFlow.js    end-to-end execution flow with mock client
```

---

## [5.3.0] — Live Trading Integration (Paper + Real)

### Added
- **Real Polymarket CLOB integration** — place/cancel orders, stream orderbooks, sync positions
- **Paper + live mode separation** — share same code path; switch via `TRADING_MODE` env var
- **Kill switch** — file-sentinel (`.KILL`), env var (`KILL_SWITCH=1`), SIGINT/SIGTERM, all converge on `cancelAllOrders()`

### New modules (all in `src/live/`, Node.js only)
```
src/live/
├── config.js             env-driven configuration + mode selector + validation
├── logger.js             structured JSONL logs (decisions / trades / errors)
├── retry.js              exponential backoff + jitter, retryable classifier
├── polymarketClient.js   CLOB + Gamma API façade with TTL caching
├── wallet.js             ethers wallet, USDC balance, CTF positions, approvals
├── liveRisk.js           daily-loss stop, concurrent-order cap, slippage, emergency stop
├── liveExecution.js      placeOrder / cancelOrder / getOpenOrders / syncPositions
├── liveSignals.js        bridge CLOB orderbooks → existing Phase 1 alpha (momSigs, orderflowSigs)
└── eventLoop.js          5-second continuous loop with graceful shutdown
scripts/
├── runLive.js            entry point (npm run live:paper | npm run live)
└── tradeHistory.js       CLI log viewer (bonus)
config-examples/
└── .env.example          every configurable parameter documented
```

### Design decisions
- **Paper mode is dependency-free** — live mode only pulls in `@polymarket/clob-client` and `ethers` via dynamic `import()`. Both are listed under `optionalDependencies` so `npm install` works without them.
- **Phase 1/2 engine untouched** — `src/engine/*` imported verbatim. Live signals flow: CLOB orderbook → `liveSignals.ingestOrderbook` → `momSigs` / `orderflowSigs` → `processSigs` → `liveExecution.placeOrder`.
- **Risk layered** — `liveRisk.js` is the *outer* gate (real-money limits); existing `src/engine/risk.js` remains the *inner* gate (position/exposure consistency). Both run per order.
- **No credentials in code** — `PRIVATE_KEY`, `FUNDER_ADDRESS`, API keys read from env only. `.env.example` provided; `.env` gitignored.

### Verified
- All 11 new files pass `node --check`
- Paper-mode smoke test runs cleanly: config validates, wallet initializes (stub), event loop ticks, SIGTERM triggers cancelAll + graceful shutdown
- Error handling verified via 403 from Gamma API (geo-block in sandbox) — no crash, logged to `errors.jsonl`, loop continues
- React app (V5.2 simulator) untouched — no `live/` imports in `App.jsx` or `main.jsx`
- `npm run trades:all` CLI displays trade log correctly

### Commands
```bash
npm run live:paper       # paper trading (no credentials needed)
npm run install:live     # install CLOB SDK + ethers for live mode
npm run live             # real trading (requires PRIVATE_KEY env)
npm run trades           # view last 50 trade log entries
npm run trades -- --since=1h --event=live:placeOrder
```

---

## [5.2.0] — Phase 2 Modular Extraction

### Changed
- **Extracted core engine from App.jsx into 5 new modules.** Zero behavior change.
- App.jsx reduced 1202 → 276 lines (orchestration + UI only).

### New modules
```
src/engine/
├── execution.js    canTransition, createOrder, advanceOrderFills,
│                   resolvePartialFill, computeAdaptiveLimit,
│                   TERMINAL, TRANSITIONS, FSM lifecycle
├── risk.js         calcExposure, preTradeRisk (8-check pipeline)
├── portfolio.js    applyFills, rebuildPositionsFromFills,
│                   computeMetrics, applyAttributionEvents
├── system.js       reconcile, tripCB, updateCB, record* trackers,
│                   appendEventLog, computePerformanceMetrics,
│                   pruneOrderHistory, collectProtectedOrderIds
└── tick.js         initState, tick (orchestration only)
src/tests/
└── runTests.js     52-test deterministic suite
```

### Validation
- 52/52 tests pass after extraction
- Deterministic replay: `initState(42) + tick(s, 10000)` byte-identical to V5.1
- 100-tick cross-check vs V5.1 baseline: **byte-identical** final equity,
  fills, orderSeq, orders, orderHistory, eventLog, realizedPnl, CB state
- App.jsx contains zero business logic (only imports + React UI + orchestration)

### Architecture rules enforced
- All engine modules are pure functions (input → output)
- No React imports inside `src/engine/*` or `src/tests/*`
- No direct state mutation outside returned values
- All randomness via seeded RNG

---

## [5.1.0] — Phase 1 Modular Refactor

### Changed
- **Extracted pure/low-risk modules from single-file App.jsx into a module tree.**
- No behavior change: 52/52 deterministic tests pass, determinism verified.
- Imports only — no new logic, no signature changes.

### File tree
```
src/
├── App.jsx              (main — reduced, imports from modules below)
├── config/
│   ├── config.js        CFG
│   ├── marketDefs.js    MDEFS, PAIRS, NEWS
│   └── constants.js     SRC_W, SRCS
├── engine/
│   ├── types.js         JSDoc typedefs
│   ├── prng.js          createRng
│   ├── history.js       pushHist, hRoc, hSma, hStd, hVol
│   ├── regime.js        detectRegime, computeWeights
│   ├── market.js        createLOB, refreshLOB, matchOrderAgainstLOB,
│   │                    computeMarketImpact, applyAdverseSelection,
│   │                    advMkt, buildBook, validateMarket,
│   │                    computeCorrelationMatrix, checkCorrelatedExposure
│   └── alpha.js         genNews, nlpSigs, momSigs, arbSigs,
│                        orderflowSigs, processSigs
└── utils/
    └── math.js          cl, r4
```

### Not extracted yet (reserved for Phase 2)
- Execution (FSM, orders, fills, slippage)
- Risk (preTradeRisk, calcExposure)
- Portfolio (applyFills, computeMetrics, applyAttributionEvents)
- Reconciliation
- Circuit breaker
- Pruning
- Event log
- Performance metrics
- State + tick loop
- React UI components

### Notes
- Uses `.js` (JSDoc typedefs) not `.ts` — keeps Vite/JSX compatibility without toolchain change.
- Named exports throughout.
- No new libraries, no framework change.

---

## [5.0.0] — Market-Realistic Alpha-Driven Engine

### Phase 1: LOB + Execution Realism
- Real limit order book with FIFO matching engine per market
- Queue position tracking, partial fills via depth consumption
- No random fill probability — fills only via matching engine
- Depth replenishment with regime-aware stress widening

### Phase 2: Market Impact + Liquidity
- Square-root impact model: sqrt(qty/ADV) × coefficient
- Adverse selection: mid price moves against aggressive fills
- Temporary impact decays over configurable ticks
- Dynamic spread widening under high-vol / low-liq stress

### Phase 3: Real Alpha Engine
- Orderflow imbalance signals from LOB bid/ask depth ratio
- Cointegration-aware stat arb with ADF-like stationarity check
- Multi-timeframe volatility-adjusted momentum (short/mid/long)
- NLP with latency penalty on confidence

### Phase 4: Portfolio Intelligence
- Rolling correlation matrix across all markets
- Correlated exposure constraint in pre-trade risk
- Volatility-targeted sizing: scale by vol-target / market-vol
- Kelly fraction capped by regime confidence level

### Phase 5: Smart Execution
- Adaptive limit pricing from LOB state (immediate/patient/passive)
- TWAP slice scheduling for large orders
- Cancel/replace on excessive limit-to-mid drift

### Phase 6: Event Sourcing
- Append-only structured event log (ORDER, FILL, NEWS, SIGNAL)
- Bounded to 2000 entries (trims to 1500)
- Full replay from events (deterministic)

### Phase 7: Performance Metrics
- Sharpe ratio (rolling, annualized)
- Win rate from realized attribution
- Average slippage (bps)
- Execution quality assessment
- Alpha contribution per signal source

### Infrastructure
- 52 deterministic tests, all passing
- Determinism verified: same seed + time = same output
- All V4.3.2 guarantees preserved (FSM, attribution, CB, recon, pruning)

---

## [4.3.2] — Correctness + Clarity Patch

### Fixed
- **Half-open CB cap was qty, not notional**: `cbHalfOpenMaxNotional=200` was compared directly against qty. Now converted to qty via `Math.floor(notional / sidePrice)`. At price 0.20, allows 1000 shares instead of wrongly capping at 200.
- **Half-open probe accounting used qty as notional**: `halfOpenNotional` accumulated `totalFilled` (qty) instead of `qty × price`. Now uses real fill notional.
- **Sizing used hardcoded initialEquity**: `processSigs` now takes live state and sizes from: live equity × DD scale, clamped by remaining gross-notional room, per-market qty room, per-category qty room, and half-open CB cap.
- **Poor-fill evaluation operator precedence bug**: `!TERMINAL || (TERMINAL && ...)` always fired for non-terminal. Replaced with clear booleans.
- **4 test fixture bugs**: slip-rejection rng, zero-PnL prices, empty positions in recon, decayed signal edge.

### Improved
- **Risk clarity**: `preTradeRisk` rewritten with explicit names: `requestedQty`, `allowedQty`, `sidePrice`, `additionalNotional`, `remainingNotionalCapacity`. 8 numbered checks in stable sequence.
- **Pruning clarity**: `collectProtectedOrderIds` with explicit seed + bounded transitive closure (max 50 iterations). `pruneOrderHistory` always returns flat array, defensive `Array.isArray`, respects both retention cap and min-terminal.
- **Attribution hardening**: `applyAttributionEvents` rejects arrays, nulls, non-finite rpnl/pct.

### Added
- 12 new tests (Tests 33–44): half-open notional cap, live-equity sizing, DD scale, notional room clamping, pruning shape/lineage, terminal immutability, probe recovery, duplicate fill idempotency, closing-only attribution, malformed attr handling.
- **115 total tests, all passing. Determinism verified.**

---

## [4.3.1] — Meta-Alpha Attribution Correctness

### Fixed
- **Attribution bug**: removed "most recent order in market" `.pop()` lookup that misattributed PnL to wrong signal source
- **Position-level delta bug**: attribution was computed as single market-level delta instead of per-fill
- **Missing fill lineage**: fills now carry `attr` field from originating order (fill→order→signal chain)
- **Partial close attribution**: only closing portion's realized PnL is attributed; opening remainder correctly ignored

### Added
- `applyAttributionEvents(metaPerf, attrEvents)` — pure, deterministic attribution function
- `attrEvents` output from `applyFills` — per-fill realized PnL attribution events
- `attr` field on fill structs — source lineage from originating order
- `meta:attr` event type in system event log
- 9 new attribution tests (Tests 24-32)

### Guarantees
- No unrealized PnL learning
- No fill-quality proxy learning
- Same fills + same attr = same metaPerf updates under replay
- `applyAttributionEvents` is pure: does not mutate inputs

---

## [4.3.0] — Correctness + Determinism + Lifecycle Hardening

### Fixed
- Terminal state immutability (FILLED/CANCELLED/REJECTED/REPLACED cannot transition)
- Order ID collisions with tick-local sequence counter
- Child-level fill key dedup in `advanceOrderFills`
- Circuit breaker `tripCB` mutation leak (now pure, returns new object)
- `recentRejects` was unbounded counter (now windowed array)
- Poor fill recorded before all children evaluated
- History pruning only protected one direction of lineage chain

### Added
- `makeOrderId` with deterministic sequence counter
- `orderSeq` persisted in state across ticks
- Transitive closure in `collectProtectedIds` for lineage protection
- `historyMinRetainTerminal` enforcement in pruning
- 23 deterministic tests

---

## [4.2.0] — Circuit Breaker + Risk + Exposure Consistency

### Fixed
- Poor fills tracked but never tripped circuit breaker
- Invalid market data was quarantine-only, didn't feed CB
- Slippage CB used `allFills.slice` (unbounded) instead of windowed array
- Exposure check mixed quantity and notional units
- Category caps not labeled as quantity-based

### Added
- Full 3-state CB FSM (closed/open/half_open)
- 6 trip triggers: drawdown, exposure, slippage, rejects, poor fills, invalid data
- Windowed event arrays for slippage, poor fills, invalid data
- Half-open probe with deterministic recovery criteria
- Auditable CB trigger log
