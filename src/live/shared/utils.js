export function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function clampProbabilityPrice(price, min = 0.01, max = 0.99) {
  return clampNumber(price, min, max);
}

/**
 * Convert PositionStore.snapshot() output into processSigs() positions shape.
 */
export function toSignalPositions(positionSnapshot) {
  const out = {};
  for (const p of positionSnapshot?.positions || []) {
    out[p.tokenId] = {
      yesQty: p.qty > 0 ? p.qty : 0,
      noQty: p.qty < 0 ? -p.qty : 0,
    };
  }
  return out;
}
