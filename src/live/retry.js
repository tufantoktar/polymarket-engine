// ═══════════════════════════════════════════════════════════════════════
//  src/live/retry.js — exponential backoff + jitter
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG } from "./config/index.js";
import { getLogger } from "./logging/index.js";

/**
 * Classify errors into retryable vs non-retryable.
 * Retryable: network timeouts, 5xx, 429 (rate limit)
 * Non-retryable: 4xx client errors (auth, validation, not-found)
 */
export function isRetryable(err) {
  if (!err) return false;
  // Network / timeout
  const code = err.code || err.errno;
  if (["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code)) return true;
  // HTTP status
  const status = err.status ?? err.response?.status;
  if (typeof status === "number") {
    if (status === 429) return true;           // rate-limit
    if (status >= 500 && status < 600) return true; // server error
    return false;                              // 4xx → do not retry
  }
  // Default: assume transient
  return true;
}

/**
 * Run `fn` with exponential backoff + jitter.
 * Caller supplies an operation label used for logging.
 */
export async function withRetry(fn, opts = {}) {
  const cfg = opts.cfg || LIVE_CONFIG;
  const log = opts.logger || getLogger(cfg);
  const label = opts.label || "op";
  const maxAttempts = opts.maxAttempts ?? cfg.retry.maxAttempts;
  const baseDelay = opts.baseDelayMs ?? cfg.retry.baseDelayMs;
  const maxDelay = opts.maxDelayMs ?? cfg.retry.maxDelayMs;

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const retryable = isRetryable(e);
      log.errorEvent(`${label}:attempt${attempt}`, e, { attempt, retryable });
      if (!retryable || attempt === maxAttempts) throw e;

      // Exponential backoff with jitter
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      const jitter = Math.floor(Math.random() * (delay * 0.3));
      await sleep(delay + jitter);
    }
  }
  throw lastErr;
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
