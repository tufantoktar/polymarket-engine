// ═══════════════════════════════════════════════════════════════════════
//  src/live/logger.js — structured logging for live trading
// ═══════════════════════════════════════════════════════════════════════
//  Writes newline-delimited JSON (JSONL) to separate files per category:
//    - decisions.jsonl   every signal/risk/execution decision
//    - trades.jsonl      every order placed, filled, cancelled
//    - errors.jsonl      every API error, retry, exception
//
//  Design: file handles kept open, flushed on SIGINT/SIGTERM.
//  JSONL format chosen so logs are streamable + grep-able.

import fs from "node:fs";
import path from "node:path";
import { LIVE_CONFIG } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger {
  constructor(cfg = LIVE_CONFIG) {
    this.cfg = cfg;
    this.levelThreshold = LEVELS[cfg.logging.level] || LEVELS.info;
    this._streams = {};
    this._closed = false;
    try {
      fs.mkdirSync(cfg.logging.dir, { recursive: true });
    } catch (e) {
      // Non-fatal; will surface on first write
      console.error("[logger] mkdir failed:", e.message);
    }
    // Graceful shutdown
    process.on("SIGINT", () => this.close());
    process.on("SIGTERM", () => this.close());
  }

  _stream(fileName) {
    if (this._closed) return null;
    if (!this._streams[fileName]) {
      const p = path.join(this.cfg.logging.dir, fileName);
      this._streams[fileName] = fs.createWriteStream(p, { flags: "a" });
    }
    return this._streams[fileName];
  }

  _write(fileName, obj) {
    const s = this._stream(fileName);
    if (!s) return;
    try {
      s.write(JSON.stringify(obj) + "\n");
    } catch (e) {
      console.error("[logger] write failed:", e.message);
    }
  }

  _stamp(level, category, msg, data = {}) {
    return {
      ts: new Date().toISOString(),
      t: Date.now(),
      level,
      category,
      msg,
      mode: this.cfg.mode,
      ...data,
    };
  }

  // ── Generic log methods ──
  debug(msg, data) { this._log("debug", msg, data); }
  info(msg, data)  { this._log("info", msg, data); }
  warn(msg, data)  { this._log("warn", msg, data); }
  error(msg, data) { this._log("error", msg, data); }

  _log(level, msg, data = {}) {
    if (LEVELS[level] < this.levelThreshold) return;
    const entry = this._stamp(level, "general", msg, data);
    // Echo to stdout/stderr
    const line = `[${entry.ts}] [${level.toUpperCase()}] ${msg}` + (Object.keys(data).length ? " " + JSON.stringify(data) : "");
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  }

  // ── Structured categorical loggers ──

  /** Every decision made by the signal/risk/execution pipeline. */
  decision(stage, payload) {
    const entry = this._stamp("info", "decision", stage, payload);
    this._write(this.cfg.logging.decisionLogFile, entry);
  }

  /** Every order lifecycle event: placed, filled, partial, cancelled, failed. */
  trade(event, payload) {
    const entry = this._stamp("info", "trade", event, payload);
    this._write(this.cfg.logging.tradeLogFile, entry);
    // Also echo to console for live monitoring
    console.log(`[trade] ${event}`, payload);
  }

  /** API failures, retries, exceptions. */
  errorEvent(source, err, context = {}) {
    const entry = this._stamp("error", "error", source, {
      message: err?.message || String(err),
      stack: err?.stack,
      status: err?.status,
      data: err?.data,
      ...context,
    });
    this._write(this.cfg.logging.errorLogFile, entry);
    console.error(`[error] ${source}: ${entry.message}`);
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    for (const s of Object.values(this._streams)) {
      try { s.end(); } catch { /* ignore */ }
    }
  }
}

// Singleton instance
let _instance = null;
export function getLogger(cfg = LIVE_CONFIG) {
  if (!_instance) _instance = new Logger(cfg);
  return _instance;
}
