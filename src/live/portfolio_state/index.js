import { LIVE_CONFIG } from "../config/index.js";
import { getLogger } from "../logging/index.js";
import { toSignalPositions } from "../shared/utils.js";

function resolvePortfolioConfig(cfg) {
  const c = cfg?.portfolio || {};
  return {
    defaultCurrentDD: c.defaultCurrentDD ?? 0,
    defaultCbState: c.defaultCbState ?? "closed",
  };
}

/**
 * PortfolioState owns construction of the live-state snapshot consumed
 * by the signal engine.
 */
export class PortfolioState {
  constructor({ cfg = LIVE_CONFIG, logger = null, wallet, positionStore } = {}) {
    this.cfg = cfg;
    this.log = logger || getLogger(cfg);
    this.wallet = wallet;
    this.positionStore = positionStore;
    this.portfolioCfg = resolvePortfolioConfig(cfg);
  }

  async buildLiveState() {
    const walletSnap = await this.wallet.snapshot();
    const positionSnap = this.positionStore.snapshot();

    return {
      equity: walletSnap.usdc,
      currentDD: this.portfolioCfg.defaultCurrentDD,
      grossExposure: positionSnap.exposure.gross,
      positions: toSignalPositions(positionSnap),
      cbState: this.portfolioCfg.defaultCbState,
    };
  }
}
