// ═══════════════════════════════════════════════════════════════════════
//  src/live/execution/v2OrderBuilder.js — Polymarket CLOB V2 order builder
// ═══════════════════════════════════════════════════════════════════════
//  Phase 1 — CLOB V2 migration.
//
//  Pure helpers that construct the V2 order payload from a strategy-level
//  intent. No SDK calls, no network. Lives outside the SDK so it can be
//  unit-tested deterministically.
//
//  V2 order struct (Phase 1 target shape):
//    {
//      salt:           string  numeric salt (for order uniqueness)
//      maker:          string  0x-address that owns the funds
//      signer:         string  0x-address signing the order
//      tokenId:        string  outcome token id (CTF position id)
//      makerAmount:    string  amount the maker provides (USDC base units)
//      takerAmount:    string  amount the maker receives (CTF base units
//                              for BUY, USDC base units for SELL)
//      side:           string  "BUY" | "SELL"
//      signatureType:  number  0=EOA, 1=email/magic, 2=browser-wallet
//      timestamp:      string  unix-seconds when order was constructed
//      metadata:       object  optional structured metadata
//      builder:        string? optional 0x-address of the builder
//    }
//
//  V1 fields explicitly NOT included:
//    - nonce
//    - feeRateBps
//    - taker
// ═══════════════════════════════════════════════════════════════════════

const COLLATERAL_DECIMALS = 6;   // USDC / pUSD on Polygon
const SHARE_DECIMALS = 6;        // CTF outcome tokens (1.0 share == 1e6)

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// ─── Validation helpers ────────────────────────────────────────────────
function isPositiveFinite(x) {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

function assertAddress(name, addr) {
  if (typeof addr !== "string" || !ADDRESS_RE.test(addr)) {
    throw new Error(`v2OrderBuilder: '${name}' must be a 0x-prefixed 20-byte address, got '${addr}'`);
  }
}

function assertSide(side) {
  if (side !== "BUY" && side !== "SELL") {
    throw new Error(`v2OrderBuilder: side must be 'BUY' or 'SELL', got '${side}'`);
  }
}

function assertPrice(price) {
  if (!isPositiveFinite(price) || price >= 1) {
    throw new Error(`v2OrderBuilder: price must be in (0, 1), got '${price}'`);
  }
}

function assertSize(size) {
  if (!isPositiveFinite(size)) {
    throw new Error(`v2OrderBuilder: size must be > 0, got '${size}'`);
  }
}

function assertTokenId(tokenId) {
  if (typeof tokenId !== "string" || tokenId.length === 0) {
    throw new Error(`v2OrderBuilder: tokenId must be a non-empty string, got '${tokenId}'`);
  }
}

function assertSignatureType(t) {
  if (![0, 1, 2].includes(t)) {
    throw new Error(`v2OrderBuilder: signatureType must be 0, 1, or 2, got '${t}'`);
  }
}

// ─── Deterministic numeric conversion ───────────────────────────────────
//
// CLOB V2 expects integer amounts in base units. We:
//   1. round to 6 decimals (precision of USDC / CTF base units)
//   2. multiply by 1e6
//   3. round to a JS-safe integer
//   4. emit as a string
//
// Using strings sidesteps JS Number precision in the payload itself.
function toBaseUnits(value, decimals = COLLATERAL_DECIMALS) {
  if (!isPositiveFinite(value)) {
    throw new Error(`toBaseUnits: value must be > 0, got '${value}'`);
  }
  const scale = Math.pow(10, decimals);
  // Round half-away-from-zero to keep deterministic across platforms.
  const scaled = Math.round(value * scale);
  if (!Number.isFinite(scaled) || scaled <= 0) {
    throw new Error(`toBaseUnits: result not finite/positive for value=${value}`);
  }
  return String(scaled);
}

/**
 * Compute V2 maker/taker amounts from a (price, size) intent.
 *
 *   BUY  — maker provides USDC, receives shares.
 *           makerAmount = price * size  (USDC base units)
 *           takerAmount = size          (share base units)
 *
 *   SELL — maker provides shares, receives USDC.
 *           makerAmount = size          (share base units)
 *           takerAmount = price * size  (USDC base units)
 *
 * Returns plain string fields suitable for V2 order struct.
 */
export function computeV2Amounts({ side, price, size }) {
  assertSide(side);
  assertPrice(price);
  assertSize(size);

  if (side === "BUY") {
    const usd = price * size;
    return {
      makerAmount: toBaseUnits(usd, COLLATERAL_DECIMALS),
      takerAmount: toBaseUnits(size, SHARE_DECIMALS),
    };
  }
  const usd = price * size;
  return {
    makerAmount: toBaseUnits(size, SHARE_DECIMALS),
    takerAmount: toBaseUnits(usd, COLLATERAL_DECIMALS),
  };
}

/**
 * Deterministic salt derivation for unit tests.
 *
 * In production we use a 32-byte random value via the SDK; for testable
 * payload construction we accept an explicit salt. If none is provided
 * AND a `now` clock is supplied, we use `now` as a deterministic salt.
 */
function resolveSalt({ salt, now }) {
  if (salt !== undefined && salt !== null) {
    return String(salt);
  }
  if (typeof now === "function") {
    return String(now());
  }
  return String(Date.now());
}

/**
 * buildV2OrderPayload — pure function that returns the V2 order payload
 * exactly as it will be passed to the V2 SDK signer.
 *
 * Inputs (intent):
 *   tokenId        — outcome token id (CTF position id)
 *   side           — "BUY" | "SELL"
 *   price          — number in (0, 1)
 *   size           — number > 0 (shares)
 *
 * Inputs (account):
 *   maker          — 0x-address (funder for non-EOA, signer for EOA)
 *   signer         — 0x-address that signs the order
 *   signatureType  — 0 EOA / 1 email-magic / 2 browser-wallet
 *   builder        — optional 0x-address attached to metadata
 *
 * Inputs (deterministic test hooks):
 *   salt           — string|number, optional override
 *   now            — () => number, optional clock injection
 *   metadata       — optional plain object, merged into payload.metadata
 *
 * Throws on any invalid input. Never logs, never mutates inputs.
 */
export function buildV2OrderPayload(intent) {
  if (!intent || typeof intent !== "object") {
    throw new Error("buildV2OrderPayload: intent object required");
  }
  const {
    tokenId,
    side,
    price,
    size,
    maker,
    signer,
    signatureType,
    builder = "",
    salt,
    now,
    metadata,
  } = intent;

  assertTokenId(tokenId);
  assertSide(side);
  assertPrice(price);
  assertSize(size);
  assertAddress("maker", maker);
  assertAddress("signer", signer);
  assertSignatureType(signatureType);
  if (builder) assertAddress("builder", builder);

  const { makerAmount, takerAmount } = computeV2Amounts({ side, price, size });

  const tsSeconds = typeof now === "function"
    ? Math.floor(now() / 1000)
    : Math.floor(Date.now() / 1000);

  const payload = {
    salt: resolveSalt({ salt, now }),
    maker,
    signer,
    tokenId,
    makerAmount,
    takerAmount,
    side,
    signatureType,
    timestamp: String(tsSeconds),
    metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
  };

  if (builder) {
    payload.builder = builder;
  }

  return payload;
}

/**
 * sanitizeOrderForLog — strip any sensitive-looking fields from a logged
 * payload. We never log private keys or raw signatures. This is paranoia:
 * the build path doesn't produce them, but downstream loggers may add
 * fields, so we filter on output too.
 */
export function sanitizeOrderForLog(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const out = { ...payload };
  for (const k of Object.keys(out)) {
    const lk = k.toLowerCase();
    if (
      lk.includes("privatekey") ||
      lk.includes("private_key") ||
      lk === "secret" ||
      lk === "passphrase" ||
      lk === "signature" ||
      lk === "sig"
    ) {
      out[k] = "[REDACTED]";
    }
  }
  return out;
}

export const __test__ = {
  toBaseUnits,
  COLLATERAL_DECIMALS,
  SHARE_DECIMALS,
};
