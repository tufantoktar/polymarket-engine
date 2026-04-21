#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/runLive.js — example entry point for live / paper trading
// ═══════════════════════════════════════════════════════════════════════
//  Usage:
//    npm run live:paper       # paper mode, no credentials needed
//    npm run live             # real trading (requires PRIVATE_KEY env)
//    node scripts/runLive.js
//
//  Environment:
//    TRADING_MODE=paper|live   mode selector (default paper)
//    PRIVATE_KEY=0x...         required for live mode
//    FUNDER_ADDRESS=0x...      required for non-EOA signature types
//    CLOB_API_KEY / _SECRET / _PASSPHRASE   optional (else auto-derived)
//    KILL_SWITCH=1             halt before first tick
//    LOG_LEVEL=debug|info|warn|error
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG, validateConfig } from "../src/live/config.js";
import { EventLoop } from "../src/live/eventLoop.js";
import { getLogger } from "../src/live/logger.js";

async function main() {
  const log = getLogger(LIVE_CONFIG);

  try {
    validateConfig(LIVE_CONFIG);
  } catch (e) {
    log.error("Config validation failed", { error: e.message });
    process.exit(1);
  }

  log.info("Polymarket Engine V5.3 — live/paper mode", {
    mode: LIVE_CONFIG.mode,
    tickIntervalMs: LIVE_CONFIG.loop.tickIntervalMs,
    maxOrderQty: LIVE_CONFIG.risk.maxOrderQty,
    maxOrderNotional: LIVE_CONFIG.risk.maxOrderNotional,
    maxDailyLoss: LIVE_CONFIG.risk.maxDailyLoss,
  });

  if (LIVE_CONFIG.mode === "live") {
    log.warn("LIVE MODE: this will place REAL orders with REAL money on Polymarket");
    log.warn("Safety limits in effect", LIVE_CONFIG.risk);
  }

  const loop = new EventLoop(LIVE_CONFIG);
  await loop.init();
  await loop.run();
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
