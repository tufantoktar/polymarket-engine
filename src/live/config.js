// ═══════════════════════════════════════════════════════════════════════
//  src/live/config.js — live-trading configuration
// ═══════════════════════════════════════════════════════════════════════
//  All runtime parameters live here. Environment variables override
//  file defaults. No credentials are committed — read from env only.
//
//  Mode resolution:
//    - TRADING_MODE=paper  → simulation-only, no network calls (default)
//    - TRADING_MODE=live   → real Polymarket CLOB orders (requires creds)
//
//  Kill switch:
//    - Create file `.KILL` in the working directory to halt immediately
//    - Or set KILL_SWITCH=1 in env
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

function env(k, def) {
  const v = process.env[k];
  return v === undefined || v === "" ? def : v;
}

function num(k, def) {
  const v = env(k, null);
  if (v === null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(k, def) {
  const v = env(k, null);
  if (v === null) return def;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export const LIVE_CONFIG = {
  // ── Mode ──
  mode: env("TRADING_MODE", "paper"),   // "paper" | "live"
  killSwitchEnabled: bool("KILL_SWITCH", false),
  killSwitchFile: env("KILL_SWITCH_FILE", ".KILL"),

  // ── Polymarket CLOB ──
  clob: {
    host: env("CLOB_HOST", "https://clob.polymarket.com"),
    gammaHost: env("GAMMA_HOST", "https://gamma-api.polymarket.com"),
    chainId: num("CHAIN_ID", 137),                           // Polygon mainnet
    // Signature type:
    //   0 = EOA (direct private key)
    //   1 = Email/Magic proxy
    //   2 = Browser wallet proxy (MetaMask etc.)
    signatureType: num("SIGNATURE_TYPE", 0),
    // Private key — NEVER commit. Read from env only.
    privateKey: env("PRIVATE_KEY", null),
    // Funder address — where USDC sits for non-EOA signature types
    funderAddress: env("FUNDER_ADDRESS", null),
    // API creds (if already generated; otherwise auto-derived from signer)
    apiKey: env("CLOB_API_KEY", null),
    apiSecret: env("CLOB_API_SECRET", null),
    apiPassphrase: env("CLOB_API_PASSPHRASE", null),
  },

  // ── Retry / backoff ──
  retry: {
    maxAttempts: num("RETRY_MAX", 3),
    baseDelayMs: num("RETRY_BASE_MS", 500),
    maxDelayMs: num("RETRY_MAX_MS", 5000),
  },

  // ── Event loop ──
  loop: {
    tickIntervalMs: num("TICK_INTERVAL_MS", 5000),   // 5 seconds per iteration
    marketRefreshMs: num("MARKET_REFRESH_MS", 15000), // Gamma API cache TTL
    orderbookRefreshMs: num("BOOK_REFRESH_MS", 2000), // CLOB book cache TTL
  },

  // ── Market filters ──
  filters: {
    // Only trade markets whose daily volume exceeds this
    minVolume24h: num("MIN_VOLUME_24H", 5000),
    // Only trade markets where spread is below this
    maxSpread: num("MAX_SPREAD", 0.05),
    // Minimum book depth on both sides (USDC notional)
    minDepth: num("MIN_DEPTH", 200),
    // Skip markets resolving in < N hours (too close to settlement)
    minHoursToResolution: num("MIN_HOURS_TO_RESOLUTION", 6),
    // Allow-list of category slugs; empty = all allowed
    allowedCategories: env("ALLOWED_CATEGORIES", "")
      .split(",").map(s => s.trim()).filter(Boolean),
  },

  // ── Risk limits (LIVE / REAL — stricter than simulation) ──
  risk: {
    // Max qty per single order (contracts)
    maxOrderQty: num("MAX_ORDER_QTY", 200),
    // Max notional per order (USDC) — whichever is smaller with qty
    maxOrderNotional: num("MAX_ORDER_NOTIONAL", 100),
    // Max total open position per market (contracts, YES+NO)
    maxPositionPerMarket: num("MAX_POSITION_PER_MARKET", 500),
    // Max number of concurrent open orders
    maxConcurrentOrders: num("MAX_CONCURRENT_ORDERS", 10),
    // Stop trading for the day if realized PnL goes below -maxDailyLoss
    maxDailyLoss: num("MAX_DAILY_LOSS", 50),   // USDC
    // Stop trading for the day after this many consecutive failed orders
    maxDailyRejects: num("MAX_DAILY_REJECTS", 20),
    // Maximum slippage in bps (vs signal price) tolerated
    maxSlippageBps: num("MAX_SLIPPAGE_BPS", 50),
  },

  // ── Execution ──
  execution: {
    // Default order type: "GTC" (good-till-cancel) or "FOK" (fill-or-kill)
    defaultOrderType: env("DEFAULT_ORDER_TYPE", "GTC"),
    // Adaptive limit offset in ticks (positive = more aggressive, crosses spread)
    limitOffsetTicks: num("LIMIT_OFFSET_TICKS", 1),
    // Cancel orders that haven't filled in this many ms
    orderTimeoutMs: num("ORDER_TIMEOUT_MS", 60000),
    // Pre-trade slippage tolerance in bps (checked against book-walk estimate)
    maxSlippageBps: num("EXEC_MAX_SLIPPAGE_BPS", 50),
    // Minimum total book-side USDC notional required to attempt an order
    minLiquidity: num("EXEC_MIN_LIQUIDITY", 200),
  },

  // ── Reconciliation & recovery (V5.5) ──────────────────────────────────
  reconciliation: {
    // How often the loop runs syncPositions() against the exchange
    intervalMs: num("RECONCILIATION_INTERVAL_MS", 30000),
    // Run reconciliation on boot after startup recovery finishes
    runOnStart: bool("RECONCILIATION_RUN_ON_START", true),
  },

  // ── Startup recovery ──
  recovery: {
    // Set to 0/false to skip the pre-loop recovery step (not recommended)
    enabled: bool("STARTUP_RECOVERY_ENABLED", true),
    // Max time we'll wait for recovery to finish before giving up
    timeoutMs: num("STARTUP_RECOVERY_TIMEOUT_MS", 30000),
  },

  // ── Monitoring / auto kill-switch thresholds ──
  monitoring: {
    // Trip after this many back-to-back order or API errors
    maxConsecutiveErrors: num("MAX_CONSECUTIVE_ERRORS", 5),
    // Trip if rolling API failure rate exceeds this fraction
    maxApiFailureRate: num("MAX_API_FAILURE_RATE", 0.5),
    // Size of the rolling window used for the API failure rate
    apiWindowSize: num("API_WINDOW_SIZE", 20),
    // A resting / partial order untouched for this long counts as stuck
    stuckOrderTimeoutMs: num("STUCK_ORDER_TIMEOUT_MS", 120000),
    // How often the event loop emits a health snapshot
    healthLogIntervalMs: num("HEALTH_LOG_INTERVAL_MS", 15000),
    // Turn the entire startup recovery feature on/off (mirrors recovery.enabled)
    startupRecoveryEnabled: bool("STARTUP_RECOVERY_ENABLED", true),
  },

  // ── Logging ──
  logging: {
    level: env("LOG_LEVEL", "info"),   // "debug" | "info" | "warn" | "error"
    dir: env("LOG_DIR", "./logs"),
    tradeLogFile: env("TRADE_LOG", "trades.jsonl"),
    errorLogFile: env("ERROR_LOG", "errors.jsonl"),
    decisionLogFile: env("DECISION_LOG", "decisions.jsonl"),
  },
};

/** Runtime validation — throws if config is inconsistent. */
export function validateConfig(cfg = LIVE_CONFIG) {
  const errors = [];

  if (!["paper", "live"].includes(cfg.mode)) {
    errors.push(`mode must be 'paper' or 'live', got '${cfg.mode}'`);
  }

  if (cfg.mode === "live") {
    if (!cfg.clob.privateKey) {
      errors.push("live mode requires PRIVATE_KEY env var");
    }
    if (![0, 1, 2].includes(cfg.clob.signatureType)) {
      errors.push(`signatureType must be 0, 1, or 2`);
    }
    if (cfg.clob.signatureType !== 0 && !cfg.clob.funderAddress) {
      errors.push("non-EOA signature types require FUNDER_ADDRESS");
    }
  }

  if (cfg.risk.maxOrderQty <= 0) errors.push("maxOrderQty must be > 0");
  if (cfg.risk.maxOrderNotional <= 0) errors.push("maxOrderNotional must be > 0");
  if (cfg.risk.maxDailyLoss <= 0) errors.push("maxDailyLoss must be > 0");
  if (cfg.loop.tickIntervalMs < 500) errors.push("tickIntervalMs must be >= 500");

  if (errors.length > 0) {
    throw new Error("Invalid live config:\n  - " + errors.join("\n  - "));
  }
  return cfg;
}

/** Detect kill-switch activation (file + env check). */
export function isKillSwitchActive(cfg = LIVE_CONFIG) {
  if (cfg.killSwitchEnabled) return true;
  try {
    const p = path.resolve(cfg.killSwitchFile);
    if (fs.existsSync(p)) return true;
  } catch { /* ignore fs errors — better to continue than crash */ }
  return false;
}
