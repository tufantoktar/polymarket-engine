# LIVE_RUNBOOK

> **Phase 1 — CLOB V2 (V5.7.0).** The live runtime targets Polymarket CLOB V2.
> The runtime imports `@polymarket/clob-client-v2` lazily and refuses to enter
> live mode without an explicit `ENABLE_LIVE_TRADING=true` opt-in plus a passing
> preflight (chain, signature, key, V2 SDK presence, optional collateral wrap).
> V1 fields like `nonce`, `feeRateBps`, and `taker` are no longer valid.
>
> **Phase 2 — Paper mode V2 validation (V5.7.1).** Paper mode is the **mandatory
> first validation step** before any live test. Paper mode runs the full V2
> runtime wiring but never places real orders, never requires `PRIVATE_KEY`,
> never requires `ENABLE_LIVE_TRADING=true`, and never requires the V2 SDK to
> be installed. Phase 2 does **not** prove live order placement works — that
> remains a later controlled live dry-run phase.

## 1. Quick Start (TL;DR)

- `cp config-examples/.env.example .env`
- Start safe first: `npm run live:paper` *(no key, no V2 SDK needed)*
- Watch first 10-20 ticks in logs (`tick:summary`)
- If healthy, set `TRADING_MODE=live` in `.env`
- Set `ENABLE_LIVE_TRADING=true` (live mode refuses to start otherwise)
- Set `POLYMARKET_CLOB_VERSION=v2` (default; Phase 1 only supports v2)
- Install live deps: `npm run install:live`
- Start live: `npm run live`
- Keep kill switch ready: `touch .KILL`

## 1.1 Preflight checklist (live mode only)

The live runtime fast-fails on startup if any of these are missing or wrong:

- `ENABLE_LIVE_TRADING=true`
- `POLYMARKET_CLOB_VERSION=v2`
- `PRIVATE_KEY` is set (never logged)
- `SIGNATURE_TYPE` is one of `0`, `1`, `2`
- `FUNDER_ADDRESS` is set when `SIGNATURE_TYPE != 0`
- `BUILDER_ADDRESS` is either empty or a 0x-prefixed 20-byte address
- Kill switch is not active (`.KILL` file absent and `KILL_SWITCH != 1`)
- V2 SDK package `@polymarket/clob-client-v2` can be imported
- If `ENABLE_COLLATERAL_WRAP=true`, both `COLLATERAL_TOKEN_ADDRESS` and
  `COLLATERAL_ONRAMP_ADDRESS` must be set
- Chain id is positive (Polygon mainnet = 137)

When the preflight fails, errors are written to stderr and `errors.jsonl`
under category `error`, and the process exits with code 1 before any
network call to the exchange.

## 2. Common Scenarios

### A) System not starting

- Symptom:
  - Process exits at startup
  - Config validation or preflight errors
- Possible cause:
  - Missing/invalid `.env` values
  - Missing live dependencies in live mode (V2 SDK not installed)
  - `ENABLE_LIVE_TRADING` not set to `true` while `TRADING_MODE=live`
  - `POLYMARKET_CLOB_VERSION` is not `v2`
  - Invalid credential fields (`PRIVATE_KEY`, `FUNDER_ADDRESS` for signature type 1/2)
  - Kill switch is active
- Action steps:
  - Check startup stderr + `logs/errors.jsonl`
  - Re-copy baseline env: `cp config-examples/.env.example .env`
  - Run paper mode first: `npm run live:paper`
  - For live mode: run `npm run install:live` and validate credentials
  - Confirm `ENABLE_LIVE_TRADING=true` and `POLYMARKET_CLOB_VERSION=v2`
  - Verify the V2 SDK is installed: `node -e "import('@polymarket/clob-client-v2').then(m => console.log('ok'))"`

### B) No trades happening

- Symptom:
  - `tick:summary` exists, but placements/trades stay near zero
- Possible cause:
  - No qualifying signals
  - Filters too strict (`MIN_VOLUME_24H`, `MAX_SPREAD`, `MIN_DEPTH`)
  - Trading blocked by recovery/risk/kill-switch state
- Action steps:
  - Check `decisions.jsonl` for signal count and placement reasons
  - Check active alerts/observability fields in `tick:summary`
  - Verify kill switch is not active (`.KILL` file not present, `KILL_SWITCH!=1`)
  - Relax filters/risk thresholds carefully and retest in paper mode

### C) Too many rejected orders

- Symptom:
  - Frequent reject reasons in decisions
  - Rising reject counters
- Possible cause:
  - Risk caps too tight
  - Notional/size constraints constantly exceeded
  - Low depth / invalid order assumptions
- Action steps:
  - Inspect reject reasons in `decisions.jsonl`
  - Verify `MAX_ORDER_QTY`, `MAX_ORDER_NOTIONAL`, `MAX_CONCURRENT_ORDERS`, `MAX_DAILY_REJECTS`
  - Run paper mode and confirm reject profile before live retry

### D) High slippage

- Symptom:
  - Slippage-related rejects
  - Poor fill quality
- Possible cause:
  - Thin books
  - Aggressive sizing
  - Tight slippage tolerance
- Action steps:
  - Check slippage decisions in `decisions.jsonl`
  - Reduce order size / notional
  - Tighten market selection (depth/spread filters)
  - Re-test in paper mode before live restart

### E) API failures

- Symptom:
  - Repeated API/network errors in `errors.jsonl`
  - Retry noise increasing
- Possible cause:
  - Network/RPC instability
  - Upstream API issues
  - Credential/auth issues
- Action steps:
  - Check `errors.jsonl` for operation + status/code
  - Validate network, RPC URL, and credentials
  - Observe if failure-rate or consecutive-error kill switch triggers
  - Pause live trading until error rate stabilizes

### F) Kill switch triggered

- Symptom:
  - Tick processing skips trading
  - Halt reason appears in summaries/logs
- Possible cause:
  - Manual trigger (`.KILL` or `KILL_SWITCH=1`)
  - Auto-trigger (loss limit, error rate, stuck orders, etc.)
- Action steps:
  - Read trigger detail from `decisions.jsonl` / `errors.jsonl`
  - If manual: remove `.KILL` and/or set `KILL_SWITCH=0`
  - If auto: fix root cause first; do not blindly restart live mode
  - Validate recovery in paper mode before resuming live

## 3. Emergency Procedures

### Stop trading immediately

- Create kill file:

```bash
touch .KILL
```

- Confirm halt state appears in `tick:summary`.

### Cancel all orders

- Preferred path: send graceful stop signal (runtime shutdown path calls cancel-all).
- If attached terminal:
  - `Ctrl+C`
- If detached process:
  - `kill -TERM <pid>`

### Safe shutdown

- Use `SIGINT`/`SIGTERM` only (avoid hard kill unless unavoidable).
- Verify process exits cleanly and snapshot/log flush completes.

## 4. Debugging

Check logs in this order:

1. `logs/errors.jsonl`
- First stop for failures
- Look for repeating `source/op`, HTTP status, network codes

2. `logs/decisions.jsonl`
- Signal counts
- Risk decisions
- Order transition path
- `tick:summary` for full runtime heartbeat

3. `logs/trades.jsonl`
- Placement/fill/cancel flow
- Trade-level reality vs expected behavior

How to interpret quickly:

- No `tick:summary`: loop likely not healthy
- Signals > 0, placements = 0: gating/risk/filter issue
- Placements > 0, fills low: market/liquidity execution issue
- Repeating same error source: prioritize that subsystem first

## 5. Recovery

### Restart flow

- Stop process cleanly
- Ensure kill-switch is cleared (unless intentionally active)
- Restart in paper mode first if cause is not fully understood
- Resume live mode only after stability check

### Snapshot restore

- Runtime snapshot is loaded on startup when enabled
- It helps warm-resume in-memory state after restart
- Treat exchange reconciliation as final truth

### Reconciliation

- Reconciliation runs on schedule and optionally on start
- Use reconciliation summaries to confirm drift correction
- If mismatches persist, stop live mode and investigate before continuing

## 6. Best Practices

- Always start in paper mode first
- Monitor first 10-20 ticks before trusting behavior
- Use conservative size/notional at startup
- Keep kill switch procedure ready before every live session
- Do not continue live trading under unresolved recurring API/risk errors
- Make one config change at a time; verify impact in paper mode
