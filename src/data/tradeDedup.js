// ═══════════════════════════════════════════════════════════════════════
//  src/data/tradeDedup.js — write each trade once, not forty times
// ═══════════════════════════════════════════════════════════════════════
//  THE PROBLEM
//
//  The recorder polls data-api /trades every ten seconds. That endpoint
//  returns the most recent trades venue-wide, and a given trade stays
//  inside that window for several minutes, so the same trade is returned
//  on roughly forty consecutive polls. Every one of them was written.
//
//  This is not merely wasted disk. A study that counts rows counts the
//  same event forty times, which is exactly what happened: a maker
//  adverse-selection study reported 17,424 "fills" where 789 existed, and
//  every statistic derived from it was meaningless.
//
//  IDENTITY
//
//  `transactionHash` is the natural identifier and the API provides it.
//  It is not sufficient alone: one transaction settles one taker order
//  against possibly several makers, so a single hash can carry several
//  distinct fills. The key therefore includes the fields that separate
//  fills within a transaction. Dropping a genuinely distinct fill would
//  understate activity, which is the more dangerous error here, so the
//  key errs toward keeping things.
//
//  When transactionHash is absent — older recordings, or an API change —
//  the key falls back to the trade's own attributes. That fallback is
//  weaker: two identical fills by the same wallet at the same price, size
//  and second are indistinguishable and will collapse into one. The
//  deduper reports how often it had to fall back so the cost is visible
//  rather than silent.
//
//  MEMORY
//
//  A recorder runs for weeks. The seen-set is bounded by time, not by
//  count: entries older than the retention window are dropped, because a
//  trade that left the feed cannot come back. Retention is deliberately
//  several times the observed feed window so a slow poll cycle or a
//  restarted clock cannot let a duplicate through.
// ═══════════════════════════════════════════════════════════════════════

/** Retention for the seen-set. The observed feed window is ~7 minutes. */
export const DEFAULT_TTL_MS = 30 * 60_000;

/** Hard ceiling so a pathological feed cannot exhaust memory. */
export const DEFAULT_MAX_KEYS = 500_000;

/**
 * Identity of a single fill.
 *
 * @param {Object} t  raw data-api trade
 * @returns {{key: string, exact: boolean}}
 *   exact=false means transactionHash was missing and the weaker
 *   attribute-based key was used.
 */
export function tradeKey(t) {
  const asset = t.asset ?? t.tokenId ?? "";
  const wallet = t.proxyWallet ?? t.wallet ?? "";
  const side = t.side ?? "";
  const price = t.price ?? "";
  const size = t.size ?? "";
  const ts = t.timestamp ?? t.ts ?? "";

  if (t.transactionHash) {
    // Hash plus the fields that distinguish fills inside one transaction.
    return {
      key: `${t.transactionHash}|${asset}|${wallet}|${side}|${price}|${size}`,
      exact: true,
    };
  }
  return {
    key: `x|${asset}|${wallet}|${side}|${price}|${size}|${ts}`,
    exact: false,
  };
}

/**
 * Time-bounded set of trades already written.
 *
 * Deliberately not an LRU: recency of *use* is irrelevant here, only age.
 * A trade that fell out of the API's window will never be offered again,
 * so age is the correct eviction criterion and it keeps memory flat.
 */
export class TradeDeduper {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxKeys = DEFAULT_MAX_KEYS } = {}) {
    this.ttlMs = ttlMs;
    this.maxKeys = maxKeys;
    this.seen = new Map();          // key -> insertion time
    this.stats = {
      offered: 0,
      accepted: 0,
      duplicates: 0,
      inexactKeys: 0,               // trades lacking transactionHash
      evicted: 0,
      overflowDrops: 0,             // keys dropped because of the ceiling
    };
  }

  /**
   * Filter a batch, returning only trades not written before.
   * @param {Array} trades
   * @param {number} now
   */
  filterNew(trades, now = Date.now()) {
    if (!Array.isArray(trades) || trades.length === 0) return [];
    this._prune(now);
    const out = [];
    for (const t of trades) {
      this.stats.offered++;
      const { key, exact } = tradeKey(t);
      if (!exact) this.stats.inexactKeys++;
      if (this.seen.has(key)) { this.stats.duplicates++; continue; }
      this.seen.set(key, now);
      this.stats.accepted++;
      out.push(t);
    }
    this._enforceCeiling();
    return out;
  }

  _prune(now) {
    const cutoff = now - this.ttlMs;
    // Map preserves insertion order and entries are inserted in time
    // order, so the expired ones are a prefix — no full scan needed.
    for (const [k, t] of this.seen) {
      if (t >= cutoff) break;
      this.seen.delete(k);
      this.stats.evicted++;
    }
  }

  _enforceCeiling() {
    if (this.seen.size <= this.maxKeys) return;
    // Oldest first, same reasoning as _prune.
    const excess = this.seen.size - this.maxKeys;
    let i = 0;
    for (const k of this.seen.keys()) {
      if (i++ >= excess) break;
      this.seen.delete(k);
      this.stats.overflowDrops++;
    }
  }

  snapshot() {
    const s = this.stats;
    return {
      ...s,
      tracked: this.seen.size,
      duplicateRate: s.offered ? +(s.duplicates / s.offered).toFixed(4) : 0,
    };
  }
}
