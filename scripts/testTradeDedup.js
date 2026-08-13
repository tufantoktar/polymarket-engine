// ═══════════════════════════════════════════════════════════════════════
//  scripts/testTradeDedup.js — the dedup transformation
// ═══════════════════════════════════════════════════════════════════════
//  Deduplication silently removes rows. That is exactly the kind of
//  transformation that should be pinned by tests: too aggressive and it
//  destroys real observations, too lax and every statistic downstream is
//  inflated. A maker study once reported 17,424 fills where 789 existed
//  because this step did not exist.
//
//  What must hold:
//    - the same fill offered repeatedly is written once
//    - distinct fills that share a transaction hash both survive
//    - trades without a hash still deduplicate, and the weaker identity
//      is counted rather than hidden
//    - memory is bounded by time and by a hard ceiling
//    - a trade that has left the feed can expire without being resurrected
// ═══════════════════════════════════════════════════════════════════════

import { TradeDeduper, tradeKey, DEFAULT_TTL_MS } from "../src/data/tradeDedup.js";
import { DataRecorder } from "../src/data/recorder.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  if (!cond) console.error(`  FAIL ${name}${detail ? ": " + detail : ""}`);
};
const silentLog = {
  info: () => {}, warn: () => {}, debug: () => {}, error: () => {},
  decision: () => {}, trade: () => {}, errorEvent: () => {},
};

const trade = (o = {}) => ({
  transactionHash: "0xaaa",
  asset: "tok1",
  proxyWallet: "0xwallet1",
  side: "BUY",
  price: 0.5,
  size: 10,
  timestamp: 1_700_000_000,
  ...o,
});

// ─── Identity ───────────────────────────────────────────────────────────
{
  assert("key: identical trades share a key",
    tradeKey(trade()).key === tradeKey(trade()).key);

  assert("key: transactionHash alone does not merge distinct fills",
    tradeKey(trade()).key !== tradeKey(trade({ proxyWallet: "0xother" })).key);
  assert("key: different size is a different fill",
    tradeKey(trade()).key !== tradeKey(trade({ size: 11 })).key);
  assert("key: different price is a different fill",
    tradeKey(trade()).key !== tradeKey(trade({ price: 0.51 })).key);
  assert("key: different side is a different fill",
    tradeKey(trade()).key !== tradeKey(trade({ side: "SELL" })).key);
  assert("key: different asset is a different fill",
    tradeKey(trade()).key !== tradeKey(trade({ asset: "tok2" })).key);
  assert("key: different transaction is a different fill",
    tradeKey(trade()).key !== tradeKey(trade({ transactionHash: "0xbbb" })).key);

  assert("key: with a hash the identity is exact", tradeKey(trade()).exact === true);
  const noHash = tradeKey(trade({ transactionHash: undefined }));
  assert("key: without a hash the identity is marked inexact", noHash.exact === false);
  assert("key: the fallback key still distinguishes trades",
    noHash.key !== tradeKey(trade({ transactionHash: undefined, size: 99 })).key);

  // The fallback must not silently collide with a hashed key.
  assert("key: hashed and unhashed keys never collide",
    tradeKey(trade()).key !== noHash.key);
}

// ─── Filtering ──────────────────────────────────────────────────────────
{
  const d = new TradeDeduper();
  const t = trade();

  assert("filter: first sighting is accepted", d.filterNew([t]).length === 1);
  assert("filter: second sighting is dropped", d.filterNew([t]).length === 0);

  // The real failure mode: the same batch offered forty times.
  let written = 1;
  for (let i = 0; i < 40; i++) written += d.filterNew([t]).length;
  assert("filter: forty re-deliveries produce one row", written === 1,
    `written=${written}`);

  const s = d.snapshot();
  assert("filter: duplicates are counted, not hidden", s.duplicates === 41, `dup=${s.duplicates}`);
  assert("filter: accepted count is right", s.accepted === 1);
  assert("filter: duplicate rate is reported", s.duplicateRate > 0.9);
}

// One transaction can settle against several makers. Those are separate
// fills and all of them must survive.
{
  const d = new TradeDeduper();
  const batch = [
    trade({ proxyWallet: "0xA", size: 10 }),
    trade({ proxyWallet: "0xB", size: 20 }),
    trade({ proxyWallet: "0xC", size: 30 }),
  ];
  const out = d.filterNew(batch);
  assert("filter: three fills in one transaction all survive", out.length === 3,
    `kept=${out.length}`);
  assert("filter: re-offering that transaction adds nothing",
    d.filterNew(batch).length === 0);
}

// Mixed batches: some new, some already seen.
{
  const d = new TradeDeduper();
  d.filterNew([trade({ transactionHash: "0x1" })]);
  const out = d.filterNew([
    trade({ transactionHash: "0x1" }),   // seen
    trade({ transactionHash: "0x2" }),   // new
    trade({ transactionHash: "0x3" }),   // new
  ]);
  assert("filter: only the unseen part of a batch is kept", out.length === 2);
  assert("filter: the kept ones are the new ones",
    out.every(t => t.transactionHash !== "0x1"));
}

// Trades without a hash still deduplicate, and the weaker identity is
// visible in the stats rather than assumed.
{
  const d = new TradeDeduper();
  const t = trade({ transactionHash: undefined });
  assert("filter: unhashed trade is accepted once", d.filterNew([t]).length === 1);
  assert("filter: unhashed duplicate is dropped", d.filterNew([t]).length === 0);
  assert("filter: inexact identities are counted", d.snapshot().inexactKeys === 2,
    `inexact=${d.snapshot().inexactKeys}`);
}

// ─── Memory ─────────────────────────────────────────────────────────────
{
  const d = new TradeDeduper({ ttlMs: 1000 });
  const t = trade();
  d.filterNew([t], 0);
  assert("ttl: still remembered inside the window",
    d.filterNew([t], 900).length === 0);
  assert("ttl: forgotten after the window",
    d.filterNew([t], 5000).length === 1,
    "a trade that has left the feed cannot be re-offered, so expiry is safe");
  assert("ttl: eviction is counted", d.snapshot().evicted > 0);
}

{
  const d = new TradeDeduper({ ttlMs: 60_000, maxKeys: 100 });
  for (let i = 0; i < 500; i++) {
    d.filterNew([trade({ transactionHash: "0x" + i })], 1000 + i);
  }
  assert("ceiling: memory stays bounded", d.seen.size <= 100, `size=${d.seen.size}`);
  assert("ceiling: overflow drops are counted", d.snapshot().overflowDrops > 0);
  // The ceiling drops the OLDEST, so the most recent must still be known.
  assert("ceiling: the newest keys are the ones retained",
    d.filterNew([trade({ transactionHash: "0x499" })], 1600).length === 0);
}

{
  const d = new TradeDeduper();
  assert("edge: empty batch is safe", d.filterNew([]).length === 0);
  assert("edge: null batch is safe", d.filterNew(null).length === 0);
  assert("edge: default retention is generous relative to the ~7min feed window",
    DEFAULT_TTL_MS >= 15 * 60_000);
}

// ─── Recorder wiring ────────────────────────────────────────────────────
//  The module can be correct while the recorder forgets to use it, which
//  is how the price band came to be missing from one signal source.
{
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dedup-"));
  const raw = [
    { asset: "tokA", proxyWallet: "0xA", side: "BUY", price: 0.5, size: 10,
      timestamp: 1_700_000_000, transactionHash: "0xt1" },
    { asset: "tokA", proxyWallet: "0xB", side: "SELL", price: 0.49, size: 5,
      timestamp: 1_700_000_001, transactionHash: "0xt2" },
  ];

  const client = {
    getTradableMarkets: async () => [{
      id: "m1", question: "q", clobTokenIds: JSON.stringify(["tokA", "tokB"]),
      volume24hr: 10_000, endDate: new Date(Date.now() + 86_400_000).toISOString(),
    }],
    getOrderbook: async () => ({
      bids: [{ price: 0.49, size: 100 }], asks: [{ price: 0.51, size: 100 }],
      bestBid: 0.49, bestAsk: 0.51, midPrice: 0.5, spread: 0.02,
      bidDepth: 49, askDepth: 51,
    }),
    // Always returns the same trades, exactly like the real feed.
    getWalletTrades: async () => raw,
  };

  const rec = new DataRecorder({
    client, logger: silentLog,
    overrides: { outDir: dir, recordWalletTrades: true, maxTokens: 5 },
  });
  await rec.start();
  for (let i = 0; i < 5; i++) await rec.pollOnce(Date.now() + i * 10_000);
  await rec.stop();

  const files = await fsp.readdir(dir);
  const lines = [];
  for (const f of files) {
    const txt = await fsp.readFile(path.join(dir, f), "utf8");
    for (const l of txt.split("\n")) if (l.trim()) lines.push(JSON.parse(l));
  }
  const wt = lines.filter(l => l.type === "wallet_trades");
  const written = wt.reduce((s, e) => s + e.trades.length, 0);

  assert("recorder: repeated polls write each trade once", written === 2,
    `written=${written} across ${wt.length} events`);
  assert("recorder: duplicates are counted in stats",
    rec.stats.walletTradesDuplicate >= 8,
    `dup=${rec.stats.walletTradesDuplicate}`);
  assert("recorder: transactionHash survives into the recording",
    wt.length > 0 && wt[0].trades.every(t => typeof t.tx === "string"),
    JSON.stringify(wt[0]?.trades?.[0]));
  assert("recorder: the recorded shape is otherwise unchanged",
    wt[0].trades.every(t =>
      typeof t.tokenId === "string" && typeof t.wallet === "string" &&
      typeof t.price === "number" && typeof t.size === "number" &&
      typeof t.ts === "number"));

  await fsp.rm(dir, { recursive: true, force: true });
}

const passed = results.filter(r => r.pass).length;
console.log("");
console.log("═══════════════════════════════════════════════════");
console.log(`  Trade dedup tests: ${passed}/${results.length} passed`);
console.log("═══════════════════════════════════════════════════");
if (passed !== results.length) process.exit(1);
