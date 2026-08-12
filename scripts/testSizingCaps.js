// ═══════════════════════════════════════════════════════════════════════
//  scripts/testSizingCaps.js — what one market is allowed to cost us
// ═══════════════════════════════════════════════════════════════════════
//  Binary contracts settle at 0 or 1. When a market resolves against a
//  position it settles at 0 and there is generally no bid left to sell
//  into, so the worst case is the ENTIRE cost of the position — not a
//  drawdown on it, all of it.
//
//  Kelly sizing does not protect against this. It reads price as
//  probability, so at 0.89 it concludes the position is 89% likely to win
//  and sizes up accordingly. In the 107h backtest that produced a single
//  position costing 34.88 against a 1000 book — 3.5% of capital gone to
//  one market resolving the wrong way, while hitRate still read 84%
//  because unsellable losers never enter the trade statistics.
//
//  These assertions pin the cap end to end through processSigs, which is
//  the same sizing path live trading uses.
// ═══════════════════════════════════════════════════════════════════════

import { processSigs } from "../src/engine/alpha.js";
import { CFG } from "../src/config/config.js";

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  if (!cond) console.error(`  FAIL ${name}${detail ? ": " + detail : ""}`);
};

const NOW = 1_700_000_000_000;
const WEIGHTS = { momentum: 1, smartMoney: 1, nlp: 1, arb: 1 };

/** A signal strong enough that sizing, not signal strength, is the binding limit. */
function strongSignal(px, dir = "BUY_YES", source = "momentum") {
  return {
    id: "s1", source, time: NOW, cid: "tok", dir,
    edge: 0.40, conf: 0.9,
    fv: dir === "BUY_YES" ? Math.min(0.98, px + 0.3) : Math.max(0.02, px - 0.3),
    px, hl: 300_000, exp: NOW + 600_000, qs: 1,
  };
}

function size(px, { equity = 10_000, positions = {}, dir = "BUY_YES" } = {}) {
  const { recs } = processSigs(
    [strongSignal(px, dir)], WEIGHTS, 0.8, NOW,
    {
      equity,
      currentDD: 0,
      grossExposure: 0,
      positions,
      markets: { tok: { id: "tok", yes: px, vol: 0.02, cat: "c" } },
      cbState: "closed",
    },
  );
  return recs[0] || null;
}

// ─── 1. The cap binds ───────────────────────────────────────────────────
assert("cap: configured at 1% of capital", CFG.maxPositionLossPct === 0.01);

{
  const equity = 10_000;
  const budget = CFG.maxPositionLossPct * equity;   // 100

  for (const px of [0.20, 0.35, 0.50, 0.65, 0.80]) {
    const rec = size(px, { equity });
    assert(`cap: sized at ${px}`, rec !== null, "signal was too weak to size at all");
    if (!rec) continue;
    const worstCase = rec.sz * px;
    assert(`cap: worst case at ${px} stays within budget`,
      worstCase <= budget + 1e-6,
      `qty=${rec.sz} * ${px} = ${worstCase.toFixed(2)} > ${budget}`);
  }
}

// ─── 2. It scales with capital, not with price ──────────────────────────
{
  const small = size(0.50, { equity: 1_000 });
  const large = size(0.50, { equity: 100_000 });
  assert("cap: bigger book allows a bigger position",
    small && large && large.sz > small.sz);
  assert("cap: small book worst case within 1%",
    small && small.sz * 0.50 <= 0.01 * 1_000 + 1e-6,
    `qty=${small?.sz}`);
  assert("cap: large book worst case within 1%",
    large && large.sz * 0.50 <= 0.01 * 100_000 + 1e-6,
    `qty=${large?.sz}`);
}

// ─── 3. Existing inventory counts against the cap ───────────────────────
//  Otherwise the limit is trivially defeated by averaging in over ticks.
{
  const equity = 10_000;
  const px = 0.50;
  const budget = CFG.maxPositionLossPct * equity;

  const fresh = size(px, { equity });
  assert("cap: opens a position from flat", fresh !== null);

  // Already holding most of the allowance.
  const heldQty = Math.floor((budget * 0.9) / px);
  const topUp = size(px, { equity, positions: { tok: { yesQty: heldQty, noQty: 0 } } });
  const topUpQty = topUp ? topUp.sz : 0;
  assert("cap: existing inventory shrinks the next order",
    topUpQty < fresh.sz,
    `fresh=${fresh.sz} topUp=${topUpQty}`);
  assert("cap: held + new stays within budget",
    (heldQty + topUpQty) * px <= budget + 1e-6,
    `held=${heldQty} new=${topUpQty} total=${((heldQty + topUpQty) * px).toFixed(2)} budget=${budget}`);

  // Allowance already spent -> nothing further.
  const full = Math.ceil(budget / px);
  const blocked = size(px, { equity, positions: { tok: { yesQty: full, noQty: 0 } } });
  assert("cap: a full position blocks further buying", blocked === null,
    JSON.stringify(blocked));
}

// ─── 4. Averaging in cannot defeat it ───────────────────────────────────
//  Simulate repeated top-ups, feeding the resulting position back each
//  time, and assert the accumulated worst case never breaches the cap.
{
  const equity = 10_000;
  const px = 0.40;
  const budget = CFG.maxPositionLossPct * equity;
  let held = 0;
  for (let i = 0; i < 25; i++) {
    const rec = size(px, { equity, positions: { tok: { yesQty: held, noQty: 0 } } });
    if (!rec) break;
    held += rec.sz;
  }
  assert("cap: repeated averaging in never breaches the cap",
    held * px <= budget + 1e-6,
    `held=${held} worstCase=${(held * px).toFixed(2)} budget=${budget}`);
  assert("cap: averaging in still reaches a meaningful position",
    held > 0);
}

// ─── 5. Disabling it is possible but must be deliberate ─────────────────
{
  const saved = CFG.maxPositionLossPct;
  CFG.maxPositionLossPct = 0;
  const uncapped = size(0.50, { equity: 10_000 });
  CFG.maxPositionLossPct = saved;
  const capped = size(0.50, { equity: 10_000 });
  assert("cap: setting 0 disables it", uncapped && capped && uncapped.sz > capped.sz,
    `uncapped=${uncapped?.sz} capped=${capped?.sz}`);
  assert("cap: restoring the config restores the limit",
    capped.sz * 0.50 <= 0.01 * 10_000 + 1e-6);
}

// ─── 6. The historical failure is now prevented ─────────────────────────
//  The 34.88 position that dominated every run was bought around 0.89 on
//  a 1000 book. That price is outside the band now, but the cap must hold
//  independently — bands and caps should not depend on each other.
{
  const equity = 1_000;
  const rec = size(0.80, { equity });          // top of the band
  const worst = rec ? rec.sz * 0.80 : 0;
  assert("cap: worst single-market loss on a 1000 book is at most 10",
    worst <= 10 + 1e-6,
    `qty=${rec?.sz} worstCase=${worst.toFixed(2)}`);
  assert("cap: that is far below the 34.88 that actually happened",
    worst < 34.88);
}

// ─── 7. The cap must not silently disable half the price band ───────────
//  The dust floor used to be `desiredQty < 15`, denominated in contracts.
//  A contract floor means different things at different prices: 15
//  contracts is $3 at 0.20 and $12 at 0.80. Once a 1% per-position cap
//  existed, a 1000 book had a $10 budget, so at any side-price above
//  10/15 = $0.667 the cap could never reach 15 contracts and every such
//  signal was dropped. The first real run after the cap shipped produced
//  0 recommendations over 122 hours of data.
//
//  The floor is therefore expressed in notional as well as contracts, and
//  the whole band must remain reachable at the smallest book we test.
{
  const equity = 1_000;
  const budget = CFG.maxPositionLossPct * equity;

  assert("floor: expressed in contracts and notional",
    Number.isFinite(CFG.minOrderQty) && Number.isFinite(CFG.minOrderNotional));

  // Every price in the band must be reachable on BOTH sides.
  for (const px of [0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80]) {
    for (const dir of ["BUY_YES", "BUY_NO"]) {
      const sidePrice = dir === "BUY_YES" ? px : 1 - px;
      const qty = Math.floor(budget / sidePrice);
      const passesFloor = qty >= CFG.minOrderQty && qty * sidePrice >= CFG.minOrderNotional;
      assert(`floor: ${dir} at ${px} is reachable on a ${equity} book`,
        passesFloor,
        `qty=${qty} notional=${(qty * sidePrice).toFixed(2)}`);
    }
  }

  // And the old contract-only floor would have failed exactly here, which
  // is why this assertion exists rather than a comment.
  const OLD_FLOOR = 15;
  const worstSidePrice = 0.80;
  assert("floor: the old 15-contract floor really was unreachable",
    Math.floor(budget / worstSidePrice) < OLD_FLOOR,
    `qty=${Math.floor(budget / worstSidePrice)} — if this passes, the interaction is gone`);
}

const passed = results.filter(r => r.pass).length;
console.log("");
console.log("═══════════════════════════════════════════════════");
console.log(`  Sizing cap tests: ${passed}/${results.length} passed`);
console.log("═══════════════════════════════════════════════════");
if (passed !== results.length) process.exit(1);
