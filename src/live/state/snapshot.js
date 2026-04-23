// ═══════════════════════════════════════════════════════════════════════
//  src/live/state/snapshot.js — lightweight periodic state snapshots
// ═══════════════════════════════════════════════════════════════════════
//  Purpose: write a local JSON snapshot of the runtime state on an
//  interval so a crash / restart doesn't lose track of active orders,
//  positions, recent signals, and flags.
//
//  Design constraints (per Phase 2 brief):
//   - Local file only. No DB. No external deps.
//   - Atomic write (tmp + rename) so readers never see a partial file.
//   - Write is fire-and-forget from the main loop's POV — we use a
//     background async write and never make the loop await it.
//   - Load failures on startup must NOT halt the bot — log + continue
//     with the normal recovery flow.
//   - Save failures at runtime must NOT halt the bot — log + continue.
//   - Isolated from strategy logic.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;

/**
 * Build a serializable snapshot object from the live runtime stores.
 * Pure — easy to unit-test.
 */
export function buildSnapshot({ orderStore, positionStore, signalEngine, killSwitch, observability, health }) {
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: Date.now(),
    orders: { open: [], recentTerminal: [] },
    positions: [],
    lastSignals: [],
    flags: {},
  };

  if (orderStore) {
    // Only open (non-terminal) orders are re-used after restart. Keep a
    // small tail of terminal ones for audit/debug — capped so the file
    // doesn't grow unbounded on a busy day.
    snapshot.orders.open = orderStore.listOpenOrders().map(_serializeOrder);
    const all = orderStore.listAll();
    const terminalTail = all.filter(o => !o.state || _terminal(o.state)).slice(-50);
    snapshot.orders.recentTerminal = terminalTail.map(_serializeOrder);
  }

  if (positionStore) {
    snapshot.positions = positionStore.list().map(p => ({
      tokenId: p.tokenId,
      qty: p.qty,
      avgEntryPrice: p.avgEntryPrice,
      realizedPnl: p.realizedPnl,
      totalBuyQty: p.totalBuyQty,
      totalSellQty: p.totalSellQty,
      lastFillAt: p.lastFillAt,
    }));
  }

  if (signalEngine && signalEngine.markets) {
    // Capture the last market prices the signal engine has seen so we
    // can report sensible `unrealizedPnl` right after warm resume.
    const tail = [];
    for (const [tokenId, mkt] of signalEngine.markets) {
      tail.push({ tokenId, yes: mkt.yes, prevYes: mkt.prevYes, lastUpdate: mkt.lastUpdate });
    }
    snapshot.lastSignals = tail.slice(-50);
  }

  if (killSwitch) {
    const ks = killSwitch.snapshot();
    snapshot.flags.killSwitch = {
      halted: ks.halted,
      reason: ks.reason,
      haltedAt: ks.haltedAt,
      consecutiveErrors: ks.consecutiveErrors,
    };
  }

  if (observability) {
    snapshot.flags.observability = observability.snapshot();
  }

  if (health) {
    const h = health.getHealthStatus ? health.getHealthStatus() : null;
    if (h) {
      snapshot.flags.health = {
        running: h.running,
        halted: h.halted,
        tickCount: h.tickCount,
        lastTickAt: h.lastTickAt,
        lastReconcileAt: h.lastReconcileAt,
      };
    }
  }

  return snapshot;
}

function _serializeOrder(o) {
  // Shallow serialization — history array and children meta can balloon
  // quickly on busy markets. We strip the history but keep the fields
  // a warm-resume needs.
  return {
    orderId: o.orderId,
    externalOrderId: o.externalOrderId,
    signalKey: o.signalKey,
    marketId: o.marketId,
    tokenId: o.tokenId,
    side: o.side,
    size: o.size,
    price: o.price,
    state: o.state,
    filledSize: o.filledSize,
    avgFillPrice: o.avgFillPrice,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    placedAt: o.placedAt,
    terminalAt: o.terminalAt,
    reason: o.reason,
    meta: o.meta,
  };
}

const TERMINAL_STATES = new Set(["FILLED", "CANCELLED", "FAILED"]);
function _terminal(state) { return TERMINAL_STATES.has(state); }

/**
 * Atomic write: serialize → write to `<file>.tmp` → rename → replaces
 * the real file in one fs op (POSIX rename is atomic on the same fs).
 * Never throws — logs warning + continues.
 */
export async function writeSnapshotFile(filePath, snapshot, logger) {
  try {
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmpPath = filePath + ".tmp";
    const data = JSON.stringify(snapshot);
    await fsp.writeFile(tmpPath, data, "utf8");
    await fsp.rename(tmpPath, filePath);
    return { ok: true, bytes: data.length };
  } catch (e) {
    logger?.warn?.("snapshot:write_failed", { path: filePath, error: e.message });
    return { ok: false, error: e.message };
  }
}

/**
 * Load on startup. Returns `null` on missing file, corrupt JSON, or
 * wrong schema — never throws. Caller decides what to do with null.
 */
export function loadSnapshotFileSync(filePath, logger) {
  try {
    if (!fs.existsSync(filePath)) {
      logger?.info?.("snapshot:not_found", { path: filePath });
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw || raw.trim().length === 0) {
      logger?.warn?.("snapshot:empty_file", { path: filePath });
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      logger?.warn?.("snapshot:invalid_shape", { path: filePath });
      return null;
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      logger?.warn?.("snapshot:schema_mismatch", {
        path: filePath, expected: SCHEMA_VERSION, got: parsed.schemaVersion,
      });
      return null;
    }
    return parsed;
  } catch (e) {
    // Corrupt JSON, read error, etc — never halt the bot for this.
    logger?.warn?.("snapshot:load_failed", { path: filePath, error: e.message });
    return null;
  }
}

/**
 * Apply a loaded snapshot to the runtime stores. Best-effort: each
 * section is restored independently so a bad field in one area doesn't
 * lose the others.
 *
 * Returns a summary for logging.
 */
export function applySnapshot(snapshot, { orderStore, positionStore, signalDeduper, logger }) {
  const out = { ordersRestored: 0, positionsRestored: 0, dedupeKeysRestored: 0, errors: [] };
  if (!snapshot) return out;

  // ── Positions ─────────────────────────────────────────────────────
  try {
    if (Array.isArray(snapshot.positions) && positionStore) {
      for (const p of snapshot.positions) {
        if (!p?.tokenId) continue;
        positionStore.set(p.tokenId, p);
        out.positionsRestored++;
      }
    }
  } catch (e) {
    out.errors.push({ section: "positions", error: e.message });
  }

  // ── Open orders ──────────────────────────────────────────────────
  // We DON'T walk the FSM from IDLE for these — they already were
  // ORDER_PLACED / PARTIAL_FILL in a previous process. We register
  // them into the store as-is so their lifecycle continues. The
  // exchange reconciliation pass afterwards is the authority on
  // whether they're still open.
  try {
    if (orderStore && snapshot.orders?.open) {
      for (const o of snapshot.orders.open) {
        if (!o?.orderId || !o?.signalKey) continue;
        // Use the internal maps directly — we don't want to force a new
        // orderId or reset history.
        const restored = {
          ...o,
          // Ensure required arrays/fields exist even if older file lacks them
          history: [{ state: o.state, at: o.updatedAt || Date.now(), reason: "snapshot_restore" }],
          meta: o.meta || {},
        };
        orderStore._byOrderId.set(o.orderId, restored);
        orderStore._bySignalKey.set(o.signalKey, o.orderId);
        if (o.externalOrderId) orderStore._byExternalId.set(o.externalOrderId, o.orderId);

        // Block a fresh signal for the same key from placing a duplicate
        // while we wait for the exchange reconcile pass to confirm the
        // real state.
        if (signalDeduper) {
          signalDeduper.mark(o.signalKey, { stage: "snapshot_restore", orderId: o.orderId });
          out.dedupeKeysRestored++;
        }
        out.ordersRestored++;
      }
    }
  } catch (e) {
    out.errors.push({ section: "orders", error: e.message });
  }

  logger?.info?.("snapshot:applied", out);
  return out;
}

/**
 * Interval-driven writer. Fire-and-forget: the main loop doesn't await
 * individual writes; they run in the background with no concurrency
 * (a single inFlight guard prevents overlapping writes).
 */
export class SnapshotWriter {
  /**
   * @param {Object} opts
   *   @param {string} opts.filePath           where to write
   *   @param {number} opts.intervalMs         how often to snapshot
   *   @param {Object} opts.sources            { orderStore, positionStore, signalEngine, killSwitch, observability, health }
   *   @param {Object} opts.logger
   */
  constructor({ filePath, intervalMs, sources, logger }) {
    this.filePath = filePath;
    this.intervalMs = intervalMs;
    this.sources = sources || {};
    this.logger = logger;
    this._timer = null;
    this._inFlight = false;
    this._stats = { writes: 0, failures: 0, lastWriteAt: null, lastSizeBytes: 0 };
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => { this._tryWrite(); }, this.intervalMs);
    // Non-blocking unref so we don't keep the event loop alive solely
    // for snapshot writes if everything else exits.
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /** Force an immediate write — used on graceful shutdown. */
  async flush() {
    return this._tryWrite();
  }

  async _tryWrite() {
    if (this._inFlight) return;
    this._inFlight = true;
    try {
      const snap = buildSnapshot(this.sources);
      const res = await writeSnapshotFile(this.filePath, snap, this.logger);
      if (res.ok) {
        this._stats.writes++;
        this._stats.lastWriteAt = Date.now();
        this._stats.lastSizeBytes = res.bytes;
      } else {
        this._stats.failures++;
      }
      return res;
    } finally {
      this._inFlight = false;
    }
  }

  snapshot() {
    return {
      filePath: this.filePath,
      intervalMs: this.intervalMs,
      ...this._stats,
    };
  }
}
