#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/runLive.js — example entry point for live / paper trading
// ═══════════════════════════════════════════════════════════════════════
//  Usage:
//    npm run live:paper       # paper mode, no credentials needed
//    npm run live             # real trading (requires opt-in env vars)
//    node scripts/runLive.js
//
//  Environment:
//    TRADING_MODE=paper|live              mode selector (default paper)
//    ENABLE_LIVE_TRADING=true             REQUIRED to enter live mode
//    POLYMARKET_CLOB_VERSION=v2           required for Phase 1
//    PRIVATE_KEY=0x...                    required for live mode
//    FUNDER_ADDRESS=0x...                 required for non-EOA signature types
//    SIGNATURE_TYPE=0|1|2                 0=EOA, 1=email, 2=browser-wallet
//    POLYMARKET_CHAIN / CHAIN_ID=137      Polygon mainnet
//    BUILDER_ADDRESS=0x...                optional V2 builder field
//    ENABLE_COLLATERAL_WRAP=false         opt-in for collateral wrap path
//    COLLATERAL_TOKEN_ADDRESS=0x...       USDC / pUSD address
//    COLLATERAL_ONRAMP_ADDRESS=0x...      V2 onramp/wrap contract
//    CLOB_API_KEY / _SECRET / _PASSPHRASE optional (else auto-derived)
//    KILL_SWITCH=1                        halt before first tick
//    LOG_LEVEL=debug|info|warn|error
// ═══════════════════════════════════════════════════════════════════════

import {
  LIVE_CONFIG,
  validateConfig,
  runLivePreflight,
} from "../src/live/config/index.js";
import { EventLoop } from "../src/live/eventLoop.js";
import { getLogger } from "../src/live/logging/index.js";

async function main() {
  const log = getLogger(LIVE_CONFIG);

  try {
    validateConfig(LIVE_CONFIG);
  } catch (e) {
    log.error("Config validation failed", { error: e.message });
    process.exit(1);
  }

  // Phase 1 V2: live preflight runs after config validation but before
  // any orchestrator init. Paper mode is always permitted.
  const pre = runLivePreflight(LIVE_CONFIG);
  if (!pre.ok) {
    log.error("Live preflight failed — refusing to start", { errors: pre.errors });
    for (const e of pre.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  log.info("Polymarket Engine V5.7.1 — live/paper mode", {
    mode: LIVE_CONFIG.mode,
    clobVersion: LIVE_CONFIG.clob.version,
    enableLiveTrading: LIVE_CONFIG.enableLiveTrading,
    tickIntervalMs: LIVE_CONFIG.loop.tickIntervalMs,
    maxOrderQty: LIVE_CONFIG.risk.maxOrderQty,
    maxOrderNotional: LIVE_CONFIG.risk.maxOrderNotional,
    maxDailyLoss: LIVE_CONFIG.risk.maxDailyLoss,
  });

  if (LIVE_CONFIG.mode === "live") {
    log.warn("LIVE MODE: this will place REAL orders with REAL money on Polymarket (CLOB V2)");
    log.warn("Safety limits in effect", LIVE_CONFIG.risk);
    if (LIVE_CONFIG.collateral?.wrapEnabled) {
      log.warn("ENABLE_COLLATERAL_WRAP=true — wrap/onramp operations are permitted");
    }
  }

  const loop = new EventLoop(LIVE_CONFIG);
  await loop.init();
  await loop.run();
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
