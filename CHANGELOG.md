# Changelog

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
