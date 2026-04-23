// ═══════════════════════════════════════════════════════════════════════
//  src/live/state/signalDeduper.js — signal-level idempotency
// ═══════════════════════════════════════════════════════════════════════
//  In V5.3, every tick regenerated signals from the current orderbook.
//  If the same imbalance persisted across 3 consecutive ticks the loop
//  would happily submit 3 duplicate orders — a real money-burner.
//
//  This module fixes that with a deterministic signal key + a bounded
//  recently-seen cache. The key is built from fields that describe the
//  *intent* of the signal, not its exact numeric value, so tiny price
//  wobble doesn't produce a "new" signal every tick.
//
//  Key strategy:
//    "{source}|{marketId}|{tokenId}|{side}|{action}|{bucket}"
//
//  where `bucket` is the signal timestamp floored to a configurable
//  window (default 30s). Same imbalance within the window → same key
//  → rejected as duplicate.
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_TTL_MS = 5 * 60 * 1000;       // 5 min
const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_BUCKET_MS = 30 * 1000;        // 30 sec

/**
 * Build a deterministic dedup key from a signal.
 * Never uses randomness or mutable state.
 */
export function buildSignalKey(signal, { bucketMs = DEFAULT_BUCKET_MS } = {}) {
  if (!signal || typeof signal !== "object") {
    throw new Error("buildSignalKey: signal object required");
  }
  const source   = String(signal.source   ?? signal.strategy ?? "unk");
  const marketId = String(signal.marketId ?? signal.market   ?? "");
  const tokenId  = String(signal.tokenId  ?? signal.cid      ?? "");
  const side     = String(signal.side     ?? signal.dir      ?? "").toUpperCase();
  const action   = String(signal.action   ?? signal.urg      ?? "default");
  const ts       = Number(signal.timestamp ?? signal.ts ?? Date.now());
  const bucket   = Math.floor(ts / bucketMs) * bucketMs;
  return `${source}|${marketId}|${tokenId}|${side}|${action}|${bucket}`;
}

export class SignalDeduper {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.ttlMs=300000]       entries expire after this many ms
   * @param {number} [opts.maxEntries=5000]    LRU cap
   * @param {number} [opts.bucketMs=30000]     timestamp bucket width
   */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.bucketMs = opts.bucketMs ?? DEFAULT_BUCKET_MS;
    // Map preserves insertion order — we use it as an LRU
    this._cache = new Map();
  }

  /** Does a non-expired entry exist? (Read-only — doesn't refresh LRU.) */
  has(signalKey) {
    if (!signalKey) return false;
    const entry = this._cache.get(signalKey);
    if (!entry) return false;
    if (Date.now() - entry.markedAt > this.ttlMs) {
      this._cache.delete(signalKey);
      return false;
    }
    return true;
  }

  /**
   * Mark a signal as processed. Refreshes TTL if already present.
   * Returns the stored entry.
   */
  mark(signalKey, metadata = {}) {
    if (!signalKey) throw new Error("SignalDeduper.mark: signalKey required");
    // Evict if we're at the LRU cap (before we touch)
    if (!this._cache.has(signalKey) && this._cache.size >= this.maxEntries) {
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) this._cache.delete(oldestKey);
    }
    // Re-insert to move to LRU tail
    if (this._cache.has(signalKey)) this._cache.delete(signalKey);
    const entry = { markedAt: Date.now(), metadata };
    this._cache.set(signalKey, entry);
    return entry;
  }

  get(signalKey) {
    const entry = this._cache.get(signalKey);
    if (!entry) return null;
    if (Date.now() - entry.markedAt > this.ttlMs) {
      this._cache.delete(signalKey);
      return null;
    }
    return entry;
  }

  /** Purge expired entries. Safe to call periodically. */
  clearExpired() {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of this._cache) {
      if (now - v.markedAt > this.ttlMs) {
        this._cache.delete(k);
        removed++;
      }
    }
    return removed;
  }

  snapshot() {
    return {
      size: this._cache.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      bucketMs: this.bucketMs,
    };
  }
}
