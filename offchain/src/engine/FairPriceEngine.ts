import { AnchorReference } from "../anchor/AnchorBook.js";
import { FairPriceResult, FairPriceState, LiveFeedQuote, MarketSession } from "../types.js";
import { GuardrailConfig, clampToDeviation, maxDeviationForSession } from "./Guardrails.js";
import {
  DEFAULT_MARKET_PRESSURE,
  MarketPressureConfig,
  MarketPressureResult,
  computeMarketPressure,
} from "./MarketPressure.js";
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
  /** How sustained order flow is converted into price displacement: the
   * conviction threshold it must clear, how fast it saturates, and the share
   * of the anchor band it may occupy. See MarketPressure. */
  marketPressure?: MarketPressureConfig;
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
  /** Signed bps from MarketMakerVault.getInventorySkewBps(). Instantaneous, so
   * only used as a fallback when the smoothed reading is unavailable. */
  inventorySkewBps: number;
  /** Signed bps from MarketMakerVault.getSmoothedSkewBps() -- the demand signal
   * the engine should normally price off, since it reflects sustained
   * positioning rather than a momentary spike. */
  smoothedSkewBps?: number;
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
  private lastPressure: MarketPressureResult | null = null;

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

  /** Market-pressure decomposition from the most recent tick. Exposed for
   * operators and dashboards: it is how you tell "price is high because comps
   * rerated" apart from "price is high because the crowd is leaning". */
  getLastPressure(): MarketPressureResult | null {
    return this.lastPressure;
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

    const anchor = inputs.anchor ?? null;

    // Sustained order flow moves the *equilibrium*, it does not fight it.
    //
    // The earlier design pushed price away from a fixed centre while the anchor
    // pull dragged it back, and the two forces reached a standoff: past a
    // modest amount of imbalance the equilibrium landed outside the band and
    // price simply pinned to the edge, indifferent to whether conviction was
    // mild or overwhelming. Displacing the centre instead means every level of
    // conviction maps to a distinct price, and the band is approached
    // asymptotically rather than hit.
    const pressure = computeMarketPressure(
      inputs.smoothedSkewBps ?? inputs.inventorySkewBps,
      this.config.marketPressure ?? DEFAULT_MARKET_PRESSURE,
      anchor?.bandBps
    );
    this.lastPressure = pressure;

    if (anchor) {
      const effectiveCentre = anchor.price * (1 + pressure.displacementBps / 10_000);
      const pull = this.config.anchorPullPerTick ?? 0;
      target = target + (effectiveCentre - target) * pull;
    } else {
      target = target * (1 + pressure.displacementBps / 10_000);
    }

    // The anchor band is a hard bound, applied before the per-update guardrail.
    // It mirrors AnchorRegistry.checkBand on-chain, so the engine never
    // proposes a price the contract would reject outright. Market displacement
    // is capped strictly inside it, so in normal operation this clamp only
    // catches drift and live-feed moves, never order flow.
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
