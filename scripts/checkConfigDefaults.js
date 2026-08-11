#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/checkConfigDefaults.js — Layer 1 static check: safe defaults
// ═══════════════════════════════════════════════════════════════════════
//  The single highest-leverage catastrophe in this codebase is a flipped
//  default — e.g. `enableLiveTrading: bool("ENABLE_LIVE_TRADING", false)`
//  becoming `true`. That is a one-character diff that turns every future
//  `npm start` on any machine into real-money trading.
//
//  This check strips all relevant environment variables and then imports
//  the config module fresh, so it asserts what the SOURCE defaults to —
//  not what the current shell happens to be exporting.
//
//  Exit 0 = every safety default is safe. Exit 1 = a default is unsafe.
// ═══════════════════════════════════════════════════════════════════════

const SCRUB = [
  "TRADING_MODE",
  "ENABLE_LIVE_TRADING",
  "ENABLE_COLLATERAL_WRAP",
  "KILL_SWITCH",
  "SMART_MONEY_ENABLED",
  "DATA_RECORD_TRADES",
  "DATA_RECORD_WALLET_TRADES",
  "PRIVATE_KEY",
  "MIN_HOURS_TO_RESOLUTION",
  "MIN_VOLUME_24H",
  "MAX_ORDER_QTY",
  "MAX_ORDER_NOTIONAL",
  "MAX_DAILY_LOSS",
];
for (const k of SCRUB) delete process.env[k];

const { LIVE_CONFIG } = await import("../src/live/config/index.js");

const results = [];
const check = (name, actual, expected, why) => {
  const pass = actual === expected;
  results.push({ name, pass, actual, expected, why });
};

// ── The safety contract ────────────────────────────────────────────────
check("mode defaults to paper", LIVE_CONFIG.mode, "paper",
  "an unset TRADING_MODE must never mean live trading");

check("enableLiveTrading defaults to false", LIVE_CONFIG.enableLiveTrading, false,
  "live trading requires an explicit opt-in, never a default");

check("collateral.wrapEnabled defaults to false", LIVE_CONFIG.collateral.wrapEnabled, false,
  "wrapping real collateral must be opted into deliberately");

check("killSwitchEnabled defaults to false", LIVE_CONFIG.killSwitchEnabled, false,
  "kill switch off by default is correct; on by default would mask a real halt");

check("smartMoney.enabled defaults to false", LIVE_CONFIG.smartMoney.enabled, false,
  "V5.9 signal is unvalidated — must stay opt-in until backtested");

check("data.recordTrades defaults to false", LIVE_CONFIG.data.recordTrades, false,
  "the CLOB /trades path needs auth we do not have; default on would spam errors");

check("data.recordWalletTrades defaults to false", LIVE_CONFIG.data.recordWalletTrades, false,
  "extra polling load must be opted into");

check("clob.privateKey defaults to null", LIVE_CONFIG.clob.privateKey, null,
  "no key may ever be baked into source");

// ── Risk limits must be positive and finite ────────────────────────────
const positive = (name, v) => {
  const pass = Number.isFinite(v) && v > 0;
  results.push({ name, pass, actual: v, expected: "> 0 and finite",
    why: "a zero/NaN limit disables the control entirely" });
};
positive("risk.maxOrderQty > 0", LIVE_CONFIG.risk.maxOrderQty);
positive("risk.maxOrderNotional > 0", LIVE_CONFIG.risk.maxOrderNotional);
positive("risk.maxPositionPerMarket > 0", LIVE_CONFIG.risk.maxPositionPerMarket);
positive("risk.maxConcurrentOrders > 0", LIVE_CONFIG.risk.maxConcurrentOrders);
positive("risk.maxDailyLoss > 0", LIVE_CONFIG.risk.maxDailyLoss);
positive("risk.maxDailyRejects > 0", LIVE_CONFIG.risk.maxDailyRejects);
positive("risk.maxSlippageBps > 0", LIVE_CONFIG.risk.maxSlippageBps);

// ── Preflight must refuse live mode without the opt-in ─────────────────
{
  const { runLivePreflight } = await import("../src/live/config/index.js");
  const cfg = structuredClone(LIVE_CONFIG);
  cfg.mode = "live";
  cfg.enableLiveTrading = false;
  const pre = runLivePreflight(cfg);
  results.push({
    name: "preflight rejects live without ENABLE_LIVE_TRADING",
    pass: pre.ok === false,
    actual: `ok=${pre.ok}`,
    expected: "ok=false",
    why: "this is the last gate before real orders",
  });
}

const failed = results.filter(r => !r.pass);
if (failed.length > 0) {
  console.error(`[check:config-defaults] ${failed.length} UNSAFE default(s):`);
  for (const f of failed) {
    console.error(`  ✗ ${f.name}`);
    console.error(`      expected: ${f.expected}   actual: ${JSON.stringify(f.actual)}`);
    console.error(`      why: ${f.why}`);
  }
  process.exit(1);
}

console.log(`[check:config-defaults] OK (${results.length} invariants).`);
