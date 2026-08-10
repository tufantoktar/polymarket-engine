// ═══════════════════════════════════════════════════════════════════════
//  src/engine/smartMoney.js — V5.9 MVP: "smart money" wallet-agreement
//  signal, sourced from the public data-api.polymarket.com/trades feed.
// ═══════════════════════════════════════════════════════════════════════
//  Idea (narrow MVP — no leaderboard/PnL wallet scoring yet):
//    For each tracked token, look at recent taker trades within a
//    lookback window. Bucket notional by wallet (proxyWallet) and side.
//    Count how many *distinct* wallets are net-buyers vs net-sellers of
//    that exact outcome token (a wallet that both buys and sells in the
//    window is scored by whichever side it's net long on).
//    If enough distinct wallets agree on a direction (minAgreeingWallets)
//    and the notional is meaningfully lopsided, emit a signal.
//
//  This is intentionally simple: no wallet-quality weighting (leaderboard
//  PnL, market-maker filtering) yet — that's the natural V5.9.1 follow-up
//  once this MVP is validated in backtest. Trades from wallets tagged as
//  probable market-makers (via isMarketMaker, when the feed provides it)
//  are excluded so we don't count two-sided quoting as "agreement".
//
//  Signal shape matches momSigs/orderflowSigs so it drops straight into
//  processSigs() in alpha.js without any changes there.
// ═══════════════════════════════════════════════════════════════════════

import { cl, r4 } from "../utils/math.js";

/**
 * @typedef {Object} WalletTrade
 * @property {string} tokenId
 * @property {string} wallet
 * @property {"BUY"|"SELL"} side
 * @property {number} price
 * @property {number} size
 * @property {number} ts        epoch ms
 * @property {boolean} [isMarketMaker]
 */

function resolveSmartMoneyConfig(cfg) {
  const c = cfg || {};
  return {
    lookbackMs: c.lookbackMs ?? 900_000,        // 15 min
    minTradeNotional: c.minTradeNotional ?? 50,  // USDC, ignore dust trades
    minAgreeingWallets: c.minAgreeingWallets ?? 3,
    edgeScale: c.edgeScale ?? 0.06,
    minEdge: c.minEdge ?? 0.006,
    maxEdge: c.maxEdge ?? 0.05,
    halfLifeMs: c.halfLifeMs ?? 300_000,
    expiryMs: c.expiryMs ?? 600_000,
  };
}

/**
 * Generate smart-money agreement signals from a per-token trade buffer.
 * @param {Object<string, import('./types.js').Market>} mkts
 * @param {Object<string, WalletTrade[]>} walletTrades  tokenId -> recent trades (any order)
 * @param {number} time                                  now, epoch ms
 * @param {Object} [smCfg]                                LIVE_CONFIG.smartMoney
 * @returns {import('./types.js').Signal[]}
 */
export function smartMoneySigs(mkts, walletTrades, time, smCfg) {
  const cfg = resolveSmartMoneyConfig(smCfg);
  const sigs = [];
  const cutoff = time - cfg.lookbackMs;

  for (const [tokenId, m] of Object.entries(mkts)) {
    const trades = walletTrades[tokenId];
    if (!trades || trades.length === 0) continue;

    // Per-wallet net notional within the lookback window.
    const byWallet = new Map();
    for (const t of trades) {
      if (t.ts < cutoff || t.ts > time) continue;
      if (t.isMarketMaker) continue;
      const notional = t.price * t.size;
      if (!(notional >= cfg.minTradeNotional)) continue;
      const w = byWallet.get(t.wallet) || { buy: 0, sell: 0 };
      if (t.side === "BUY") w.buy += notional; else if (t.side === "SELL") w.sell += notional;
      byWallet.set(t.wallet, w);
    }
    if (byWallet.size === 0) continue;

    let buyWallets = 0, sellWallets = 0, buyNotional = 0, sellNotional = 0;
    for (const w of byWallet.values()) {
      if (w.buy > w.sell) { buyWallets++; buyNotional += w.buy; }
      else if (w.sell > w.buy) { sellWallets++; sellNotional += w.sell; }
    }

    const netWallets = buyWallets - sellWallets;
    if (Math.abs(netWallets) < cfg.minAgreeingWallets) continue;

    const totalNotional = buyNotional + sellNotional;
    if (totalNotional <= 0) continue;
    const dominance = Math.abs(buyNotional - sellNotional) / totalNotional;

    const edge = cl(dominance * cfg.edgeScale, 0, cfg.maxEdge);
    if (edge < cfg.minEdge) continue;

    const dir = netWallets > 0 ? "BUY_YES" : "BUY_NO";
    const agree = Math.abs(netWallets);
    const totalWallets = byWallet.size;
    const conf = +cl(0.25 + agree * 0.05 + dominance * 0.3, 0.2, 0.9).toFixed(3);
    const px = m.yes;

    sigs.push({
      id: "smart_" + tokenId + "_" + time, source: "smartMoney", time, cid: tokenId,
      dir,
      edge: +edge.toFixed(4),
      conf,
      fv: r4(cl(px + (dir === "BUY_YES" ? 1 : -1) * edge, 0.02, 0.98)),
      px,
      hl: cfg.halfLifeMs, exp: time + cfg.expiryMs,
      qs: +cl(agree / (totalWallets || 1), 0, 1).toFixed(3),
      meta: {
        buyWallets, sellWallets, totalWallets,
        buyNotional: +buyNotional.toFixed(2), sellNotional: +sellNotional.toFixed(2),
      },
    });
  }
  return sigs;
}
