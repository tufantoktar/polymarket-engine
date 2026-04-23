// ═══════════════════════════════════════════════════════════════════════
//  src/live/wallet.js — wallet + balance + approvals
// ═══════════════════════════════════════════════════════════════════════
//  Handles the Polygon/Web3 side of live trading:
//   - Wallet instantiation from a private key
//   - USDC balance (collateral token on Polygon)
//   - CTF (Conditional Token Framework) position balances
//   - Approvals for USDC + CTF to Polymarket exchange contracts
//
//  In paper mode, a minimal stub is returned so upstream code can treat
//  "balance / positions / approvals" uniformly.
// ═══════════════════════════════════════════════════════════════════════

import { LIVE_CONFIG } from "./config/index.js";
import { getLogger } from "./logging/index.js";
import { withRetry } from "./retry.js";

// Polygon mainnet contract addresses for Polymarket
// USDC.e (bridged) is the collateral; native USDC also supported by CLOB.
export const POLYGON_ADDRESSES = {
  usdcE: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",     // USDC.e (6 decimals)
  ctf: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",        // Conditional Token Framework
  exchange: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",   // Polymarket CTF Exchange
  negRiskExchange: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  negRiskAdapter: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
};

// Minimal ERC20 ABI
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

// Minimal ERC1155 ABI for CTF positions
const ERC1155_ABI = [
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved) returns (bool)",
];

const MAX_UINT256 = "0x" + "f".repeat(64);

export class Wallet {
  constructor(cfg = LIVE_CONFIG, logger = null) {
    this.cfg = cfg;
    this.log = logger || getLogger(cfg);
    this._wallet = null;
    this._provider = null;
    this._usdc = null;
    this._ctf = null;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Paper mode stub: return a fake but internally-consistent shape so
  //  upstream code can treat wallet operations uniformly.
  // ─────────────────────────────────────────────────────────────────────
  _paperStub() {
    return {
      paper: true,
      address: "0xPAPER000000000000000000000000000000000000",
      balanceUSDC: Number(process.env.PAPER_USDC_BALANCE || 1000),
    };
  }

  async _ensureReal() {
    if (this.cfg.mode !== "live") {
      throw new Error("Wallet real operation attempted in paper mode");
    }
    if (this._wallet) return;
    let ethers;
    try {
      ethers = await import("ethers");
    } catch {
      throw new Error("Live mode requires ethers. Run: npm install ethers@^5");
    }
    const providerUrl = process.env.RPC_URL || "https://polygon-rpc.com";
    this._provider = new ethers.providers.JsonRpcProvider(providerUrl, this.cfg.clob.chainId);
    this._wallet = new ethers.Wallet(this.cfg.clob.privateKey, this._provider);
    this._usdc = new ethers.Contract(POLYGON_ADDRESSES.usdcE, ERC20_ABI, this._wallet);
    this._ctf = new ethers.Contract(POLYGON_ADDRESSES.ctf, ERC1155_ABI, this._wallet);
    this.log.info("Wallet initialized", { address: this._wallet.address });
  }

  /** Return the wallet's public address (or paper stub). */
  async getAddress() {
    if (this.cfg.mode !== "live") return this._paperStub().address;
    await this._ensureReal();
    return this._wallet.address;
  }

  /** USDC balance in human units (decimals handled). */
  async getUsdcBalance() {
    if (this.cfg.mode !== "live") return this._paperStub().balanceUSDC;
    await this._ensureReal();
    return withRetry(
      async () => {
        const [raw, decimals] = await Promise.all([
          this._usdc.balanceOf(this._wallet.address),
          this._usdc.decimals(),
        ]);
        return Number(raw.toString()) / Math.pow(10, Number(decimals));
      },
      { label: "wallet:getUsdcBalance", logger: this.log }
    );
  }

  /** Qty of a specific CTF outcome token held. */
  async getPositionBalance(tokenId) {
    if (this.cfg.mode !== "live") return 0;
    await this._ensureReal();
    return withRetry(
      async () => {
        const raw = await this._ctf.balanceOf(this._wallet.address, tokenId);
        return Number(raw.toString()) / 1e6; // CTF positions also use 6 decimals for USDC-based
      },
      { label: "wallet:getPositionBalance", logger: this.log }
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Approvals
  //  Polymarket requires:
  //   1. USDC approval to exchange contracts (spending collateral)
  //   2. CTF setApprovalForAll to exchange contracts (moving positions)
  //
  //  Called once per new wallet. Idempotent — checks allowance first.
  // ─────────────────────────────────────────────────────────────────────

  /** Check whether all required approvals are in place. */
  async checkApprovals() {
    if (this.cfg.mode !== "live") {
      return { usdc: true, ctf: true, paper: true };
    }
    await this._ensureReal();
    const owner = this._wallet.address;
    const [usdcAllow, ctfApproved] = await Promise.all([
      this._usdc.allowance(owner, POLYGON_ADDRESSES.exchange),
      this._ctf.isApprovedForAll(owner, POLYGON_ADDRESSES.exchange),
    ]);
    // Consider USDC approved if allowance > ~1M USDC (arbitrary large threshold)
    const usdcOk = usdcAllow && usdcAllow.gt
      ? usdcAllow.gt("1000000000000") // 1M * 1e6
      : Number(usdcAllow.toString()) > 1e12;
    return { usdc: usdcOk, ctf: !!ctfApproved };
  }

  /**
   * Submit approvals for USDC + CTF if missing. Returns transaction hashes.
   * This is a one-time setup on a new wallet.
   */
  async ensureApprovals() {
    if (this.cfg.mode !== "live") {
      this.log.info("ensureApprovals: paper mode, skipping");
      return { paper: true };
    }
    await this._ensureReal();
    const check = await this.checkApprovals();
    const txs = {};
    if (!check.usdc) {
      this.log.info("Approving USDC for exchange");
      const tx = await withRetry(
        () => this._usdc.approve(POLYGON_ADDRESSES.exchange, MAX_UINT256),
        { label: "wallet:approveUsdc", logger: this.log }
      );
      txs.usdc = tx.hash;
      await tx.wait();
    }
    if (!check.ctf) {
      this.log.info("Setting CTF approval for exchange");
      const tx = await withRetry(
        () => this._ctf.setApprovalForAll(POLYGON_ADDRESSES.exchange, true),
        { label: "wallet:approveCtf", logger: this.log }
      );
      txs.ctf = tx.hash;
      await tx.wait();
    }
    this.log.info("Approvals ensured", txs);
    return txs;
  }

  /**
   * Compose a full live-account snapshot for monitoring / risk checks.
   */
  async snapshot() {
    if (this.cfg.mode !== "live") {
      const p = this._paperStub();
      return { address: p.address, usdc: p.balanceUSDC, approvals: { usdc: true, ctf: true }, paper: true };
    }
    const [address, usdc, approvals] = await Promise.all([
      this.getAddress(),
      this.getUsdcBalance(),
      this.checkApprovals(),
    ]);
    return { address, usdc, approvals, paper: false };
  }
}
