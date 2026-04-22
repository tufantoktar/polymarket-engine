// Shared typedefs for live-module boundaries (Phase 1 architecture).
// JSDoc types keep interfaces explicit without introducing runtime deps.

/**
 * @typedef {Object} ActiveTokenMeta
 * @property {string|null} marketId
 * @property {string} question
 * @property {string} category
 * @property {number} adv
 * @property {string|undefined} endDate
 * @property {string} tickSize
 * @property {boolean} negRisk
 */

/**
 * @typedef {Object} LiveStateSnapshot
 * @property {number} equity
 * @property {number} currentDD
 * @property {number} grossExposure
 * @property {Object<string, {yesQty:number, noQty:number}>} positions
 * @property {"closed"|"half_open"|"open"} cbState
 */

/**
 * @typedef {Object} OrderRequest
 * @property {string} signalKey
 * @property {string} tokenId
 * @property {string|null} marketId
 * @property {"BUY"|"SELL"} side
 * @property {number} price
 * @property {number} size
 * @property {"GTC"|"FOK"} orderType
 * @property {string} tickSize
 * @property {boolean} negRisk
 * @property {number} expectedPrice
 */

// Runtime no-op export to keep this module importable.
export const LIVE_TYPES = Object.freeze({});