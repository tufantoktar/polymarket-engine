# Live Trading Operations Guide

This guide explains how to run and operate the live trading system safely.

## 1. Modes

### Paper mode

- Safe operating mode for system validation.
- Uses the live runtime flow without submitting real exchange orders.
- Recommended default for first-time setup and every config change.

Run:

```bash
npm run live:paper
```

### Live mode

- Real trading mode.
- May place real orders and lose real money.
- Requires correct credentials and risk controls.

Run:

```bash
npm run install:live
npm run live
```

## 2. Setup

### Environment variables

Use `.env` for runtime configuration.

1. Copy template:

```bash
cp config-examples/.env.example .env
```

2. Set mode:

- `TRADING_MODE=paper` for safe validation
- `TRADING_MODE=live` for real trading

3. Configure live credentials when using live mode:

- `PRIVATE_KEY` (required)
- `FUNDER_ADDRESS` (required for `SIGNATURE_TYPE=1` or `2`)
- optional CLOB API credentials (`CLOB_API_KEY`, `CLOB_API_SECRET`, `CLOB_API_PASSPHRASE`)

### PRIVATE_KEY warning

- `PRIVATE_KEY` gives direct wallet control.
- Never commit `.env`.
- Never paste private keys into logs/chat/history.
- Use a dedicated wallet with limited balance for live operations.

## 3. Running the System

### Run paper mode

```bash
npm run live:paper
```

Expected startup checks:

- config validation passes
- event loop starts
- recovery status logs (paper skip is expected)
- periodic tick summaries appear

### Run live mode

```bash
npm run install:live
npm run live
```

Expected startup checks:

- config validation passes
- wallet initializes
- approvals are checked/ensured
- startup recovery completes before trading ticks continue

## 4. Logs

Default log directory: `./logs`

### `decisions.jsonl`

- structured decision trail
- signal generation summaries
- risk decisions
- order transitions
- per-tick summary (`tick:summary`)

### `trades.jsonl`

- trade lifecycle events
- order placement/cancel events
- fill events (including size/price/context)

### `errors.jsonl`

- runtime/API failures
- retry-related errors
- stage-specific failure context

Quick view command:

```bash
npm run trades
```

## 5. Monitoring

What to watch continuously:

- repeated `errors.jsonl` entries from the same stage/op
- high reject rates
- kill-switch trigger events
- reconciliation mismatch growth
- unusual order-state accumulation (stuck open orders)

### `tick:summary` meaning

`tick:summary` is the main heartbeat emitted each iteration. It provides:

- iteration timing
- active token count
- signal count
- placement outcomes
- order and position snapshot
- risk snapshot
- kill-switch state
- health snapshot
- observability counters and active alerts

If `tick:summary` stops appearing while process is running, treat as operational fault.

## 6. Kill Switch

Two operator controls are available:

### File-based kill switch

- Controlled by `KILL_SWITCH_FILE` (default `.KILL`).
- Create the file to force halt behavior.

Example:

```bash
touch .KILL
```

### Env-based kill switch

- Set `KILL_SWITCH=1` to halt from startup.

### Behavior when triggered

- Trading operations are blocked.
- Tick logic skips placement path.
- Runtime reports halted state in summaries/logs.
- Order cleanup/cancel paths are invoked by shutdown/guard logic where applicable.

## 7. Recovery

### Startup recovery

- Runs before normal live trading begins.
- Restores open-order/position-related runtime state from exchange/system context.
- In live mode, trading should not proceed until recovery path completes.

### Reconciliation

- Runs on interval and optionally at startup.
- Compares local runtime state against exchange truth.
- Corrects mismatches and records summary metrics.

## 8. Snapshot System

- Periodically persists runtime state to disk (when enabled).
- Loaded on startup to warm-resume state before/alongside recovery.
- Uses atomic write behavior to reduce partial-write corruption risk.

Why this matters:

- improves restart continuity
- reduces blind spots after crash/restart
- preserves short-term runtime context between process restarts

## 9. Safety Checklist (Before Live Trading)

1. Config check
- `.env` is present and intentional.
- `TRADING_MODE=live` set only when truly ready.

2. Risk limits
- Validate `MAX_DAILY_LOSS`, `MAX_ORDER_NOTIONAL`, `MAX_POSITION_PER_MARKET`, `MAX_CONCURRENT_ORDERS`.
- Confirm limits are conservative for wallet size.

3. Wallet balance and credentials
- Wallet is correct.
- Balance is sufficient but intentionally limited.
- Key handling is secure.

4. Paper validation first
- Run paper mode after every material config/code change.
- Confirm healthy tick summaries and no persistent error loops.

5. Operational readiness
- Kill-switch procedure is known and tested.
- Log monitoring is active.
- You can stop process cleanly (`SIGINT`/`SIGTERM`) if needed.

---

Live mode is real-money operation. Treat this as an operator-controlled system, not a fire-and-forget process.
