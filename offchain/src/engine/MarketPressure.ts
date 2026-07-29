export interface MarketPressureConfig {
  /** Smoothed skew (bps) below which the market has no influence at all.
   *
   * This is the conviction threshold: a pre-IPO name should not reprice
   * because a handful of traders leaned one way for an afternoon. Only
   * positioning sustained hard enough to clear this bar moves the published
   * price, in either direction. Below it the price sits wherever real-world
   * evidence says it should. */
  thresholdBps: number;
  /** Pressure (bps, measured *past* the threshold) at which displacement
   * reaches ~76% of the room available. Sets how quickly conviction converts
   * into price once the threshold is cleared. */
  saturationBps: number;
  /** Share of the anchor band the market may occupy, in bps. 6000 means
   * sustained flow can carry price at most 60% of the way to the band edge,
   * so real-world evidence always retains majority control of where the
   * price sits and the market can never pin itself against the bound. */
  marketShareOfBandBps: number;
  /** Displacement cap (bps) used when there is no anchor band to take a share
   * of -- i.e. an ordinary public-market asset. */
  maxDisplacementBpsNoAnchor: number;
}

export const DEFAULT_MARKET_PRESSURE: MarketPressureConfig = {
  thresholdBps: 1_500,
  saturationBps: 3_000,
  marketShareOfBandBps: 6_000,
  maxDisplacementBpsNoAnchor: 100,
};

/**
 * Converts sustained order-flow imbalance into a bounded displacement of the
 * fair price away from its evidence-derived centre.
 *
 * Three properties, in the order they apply:
 *
 * 1. **Deadband.** Pressure below `thresholdBps` produces exactly zero
 *    displacement. Noise and short-lived flow are discarded rather than
 *    smeared into the price.
 * 2. **Saturation.** Past the threshold, displacement grows through a tanh, so
 *    the first units of conviction move price most and each additional unit
 *    moves it less. A crowd that is ten times more one-sided does not get ten
 *    times the influence.
 * 3. **Bounded share.** The maximum displacement is a *fraction* of the anchor
 *    band, never the whole of it. Comparables and anchors therefore always
 *    retain majority control over the level, and because the cap is strictly
 *    inside the band the price approaches its limit asymptotically instead of
 *    slamming into a wall and pinning there.
 *
 * Sign convention: positive `smoothedSkewBps` means traders are net long --
 * excess demand -- and raises the price. This is the direction a market clears
 * in. Discouraging the crowded side is the job of the vault's skewed *fee*,
 * not of the oracle's mid, which should be aggregating the information in
 * order flow rather than fading it.
 */
export interface MarketPressureResult {
  /** Displacement applied to the centre, in bps. Signed. */
  displacementBps: number;
  /** Conviction past the deadband, in bps. Zero when below threshold. */
  effectivePressureBps: number;
  /** Displacement ceiling available given the current band, in bps. */
  roomBps: number;
  /** How much of the available room is being used, 0-1. */
  utilization: number;
}

export function computeMarketPressure(
  smoothedSkewBps: number,
  config: MarketPressureConfig,
  bandBps?: number
): MarketPressureResult {
  const roomBps =
    bandBps !== undefined
      ? (bandBps * config.marketShareOfBandBps) / 10_000
      : config.maxDisplacementBpsNoAnchor;

  const magnitude = Math.abs(smoothedSkewBps);
  if (magnitude <= config.thresholdBps || roomBps <= 0) {
    return { displacementBps: 0, effectivePressureBps: 0, roomBps, utilization: 0 };
  }

  const sign = Math.sign(smoothedSkewBps);
  const effectivePressureBps = magnitude - config.thresholdBps;

  const saturation = config.saturationBps > 0 ? config.saturationBps : 1;
  const utilization = Math.tanh(effectivePressureBps / saturation);

  return {
    displacementBps: sign * roomBps * utilization,
    effectivePressureBps: sign * effectivePressureBps,
    roomBps,
    utilization,
  };
}
