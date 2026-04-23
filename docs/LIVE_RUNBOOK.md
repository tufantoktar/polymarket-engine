# LIVE_RUNBOOK

## 1. Quick Start (TL;DR)

- `cp config-examples/.env.example .env`
- Start safe first: `npm run live:paper`
- Watch first 10-20 ticks in logs (`tick:summary`)
- If healthy, set `TRADING_MODE=live` in `.env`
- Install live deps if needed: `npm run install:live`
- Start live: `npm run live`
- Keep kill switch ready: `touch .KILL`

## 2. Common Scenarios

### A) System not starting

- Symptom:
  - Process exits at startup
  - Config validation errors
- Possible cause:
  - Missing/invalid `.env` values
  - Missing live dependencies in live mode
  - Invalid credential fields (`PRIVATE_KEY`, `FUNDER_ADDRESS` for signature type 1/2)
- Action steps:
  - Check startup stderr + `logs/errors.jsonl`
  - Re-copy baseline env: `cp config-examples/.env.example .env`
  - Run paper mode first: `npm run live:paper`
  - For live mode: run `npm run install:live` and validate credentials

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
