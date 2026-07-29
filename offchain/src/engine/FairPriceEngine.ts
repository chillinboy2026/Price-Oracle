import { AnchorReference } from "../anchor/AnchorBook.js";
import { FairPriceResult, FairPriceState, LiveFeedQuote, MarketSession } from "../types.js";
import { GuardrailConfig, clampToDeviation, maxDeviationForSession } from "./Guardrails.js";
import { RandomFn } from "../util/rng.js";

export interface FairPriceEngineConfig {
  guardrails: GuardrailConfig;
  /** Weight (0-1) given to a fresh live quote vs. the previous fair price on
   * each tick while the reference market is open. Smooths out feed noise/
   * micro-spikes instead of tracking every live tick exactly. */
  liveBlendWeight: number;
  /** Max size (bps) of the synthetic random step applied per tick while the
   * reference market is closed. This is the "stays live off-hours" half of
   * the model: deliberately conservative relative to typical intraday
   * live volatility, since there is no independent market to cross-check
   * an off-hours move against. */
  offHoursVolatilityBpsPerTick: number;
  /** Max pull (bps) the market-maker's inventory skew can exert on the fair
   * price in a single tick, in either session. Positive inventorySkewBps
   * means traders are net long / the market maker is net short; the engine
   * nudges price down in that case (and up in the opposite case), which is
   * what keeps the oracle's price responsive to real on-chain trading
   * pressure rather than only ever tracking the live feed or drifting
   * blindly off-hours. */
  skewInfluenceBps: number;
  /** Number of ticks over which to fully converge to the live price after
   * the reference market reopens, instead of jumping straight to it -- a
   * long off-hours session can leave the synthetic price meaningfully off
   * from the live open, and snapping to it in one step would likely itself
   * violate the (tighter, cross-checked) LIVE deviation guardrail. */
  reconciliationSteps: number;
  /** Fraction (0-1) of the gap to the anchored reference closed per tick when
   * an anchor is supplied. This is what stops an unobservable asset's price
   * from random-walking away from the last real-world valuation: absent order
   * flow pushing the other way, it drifts back toward the anchor rather than
   * wandering freely inside the band. */
  anchorPullPerTick?: number;
  random?: RandomFn;
}

export interface EngineInputs {
  liveQuote: LiveFeedQuote | null;
  /** Signed bps from MarketMakerVault.getInventorySkewBps(); 0 if unavailable. */
  inventorySkewBps: number;
  now: number; // unix seconds
  /** Current anchored reference for an asset with no continuous market
   * (pre-IPO). When present the engine mean-reverts toward it and hard-clamps
   * to its band; when absent the engine behaves exactly as before. */
  anchor?: AnchorReference | null;
}

export class FairPriceEngine {
  private state: FairPriceState;
  private readonly config: FairPriceEngineConfig;
  private readonly random: RandomFn;

  constructor(initialPrice: number, config: FairPriceEngineConfig, initialTimestamp = Math.floor(Date.now() / 1000)) {
    this.config = config;
    this.random = config.random ?? Math.random;
    this.state = {
      price: initialPrice,
      timestamp: initialTimestamp,
      session: MarketSession.OFF_HOURS,
      nonce: 0n,
      reopenStepsRemaining: 0,
    };
  }

  getState(): Readonly<FairPriceState> {
    return this.state;
  }

  /** Overwrites internal state to a canonically agreed price (e.g. after the
   * network reaches consensus and publishes on-chain), so this engine's next
   * tick blends from the real published price rather than its own private
   * candidate. Preserves reopenStepsRemaining, which tracks reconciliation
   * progress independent of whose candidate ends up canonical. */
  syncTo(price: number, timestamp: number, session: MarketSession, nonce: bigint): void {
    this.state = { ...this.state, price, timestamp, session, nonce };
  }

  tick(inputs: EngineInputs): FairPriceResult {
    const wasLive = this.state.session === MarketSession.LIVE;
    const isLive = inputs.liveQuote !== null;
    const session = isLive ? MarketSession.LIVE : MarketSession.OFF_HOURS;

    if (isLive && !wasLive) {
      this.state.reopenStepsRemaining = this.config.reconciliationSteps;
    }

    let target: number;
    if (isLive) {
      const liveQuote = inputs.liveQuote as LiveFeedQuote;
      let blendWeight = this.config.liveBlendWeight;
      if (this.state.reopenStepsRemaining > 0) {
        blendWeight = blendWeight / this.state.reopenStepsRemaining;
        this.state.reopenStepsRemaining -= 1;
      }
      target = this.state.price * (1 - blendWeight) + liveQuote.price * blendWeight;
    } else {
      const stepBps = (this.random() * 2 - 1) * this.config.offHoursVolatilityBpsPerTick;
      target = this.state.price * (1 + stepBps / 10_000);
    }

    // Mean-revert toward the anchored reference before order flow is applied,
    // so the pull sets where price sits absent pressure and skew moves it from
    // there -- rather than the two fighting over the same tick.
    const anchor = inputs.anchor ?? null;
    if (anchor) {
      const pull = this.config.anchorPullPerTick ?? 0;
      target = target + (anchor.price - target) * pull;
    }

    const skewBpsClamped = Math.max(-10_000, Math.min(10_000, inputs.inventorySkewBps));
    const skewAdjustmentBps = (skewBpsClamped / 10_000) * this.config.skewInfluenceBps;
    target = target * (1 - skewAdjustmentBps / 10_000);

    // The anchor band is a hard bound, applied before the per-update guardrail.
    // It mirrors AnchorRegistry.checkBand on-chain, so the engine never
    // proposes a price the contract would reject outright.
    if (anchor) {
      const lower = anchor.price * (1 - anchor.bandBps / 10_000);
      const upper = anchor.price * (1 + anchor.bandBps / 10_000);
      target = Math.min(Math.max(target, lower), upper);
    }

    const maxDeviationBps = maxDeviationForSession(session, this.config.guardrails);
    const clamped = clampToDeviation(this.state.price, target, maxDeviationBps);

    this.state = {
      price: clamped,
      timestamp: inputs.now,
      session,
      nonce: this.state.nonce + 1n,
      reopenStepsRemaining: this.state.reopenStepsRemaining,
    };

    return {
      price: this.state.price,
      timestamp: this.state.timestamp,
      session: this.state.session,
      nonce: this.state.nonce,
      // With an anchor present, confidence comes from how stale the underlying
      // real-world evidence is rather than from a session constant.
      confidenceBps: anchor ? anchor.confidenceBps : session === MarketSession.LIVE ? 10 : 50,
    };
  }
}
