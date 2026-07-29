/**
 * Beta convention used throughout this codebase.
 *
 * The comps adjustment is applied *linearly*:
 *
 *   adjustment = 1 + beta * (indexNow / indexAtAnchor - 1)
 *
 * rather than the compounding form `(indexNow / indexAtAnchor) ^ beta`.
 *
 * This is deliberate, for two reasons. First, it is what "beta" means in the
 * ordinary linear-return sense that beta is *estimated* under below, so the
 * estimation and the application agree. Second, fractional exponentiation is
 * impractical in Solidity integer math, and the on-chain band recentering in
 * AnchorRegistry must reproduce this arithmetic exactly -- if the contract and
 * the off-chain engine disagreed by even a rounding step, the engine would
 * propose prices the contract rejects.
 *
 * The two forms diverge for large index moves; `maxCompAdjustmentBps` bounds
 * how far the adjustment can travel in any case, which keeps the linearization
 * inside the range where it is a good approximation.
 */

export const BPS = 10_000;

/** Log returns of a price series, which is the correct input for a covariance
 * beta: simple returns are asymmetric under compounding and bias the estimate. */
export function logReturns(series: number[]): number[] {
  if (series.length < 2) return [];
  const returns: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const curr = series[i];
    if (prev <= 0 || curr <= 0) throw new Error("logReturns requires strictly positive prices");
    returns.push(Math.log(curr / prev));
  }
  return returns;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface BetaEstimate {
  beta: number;
  /** Fraction of the asset's variance explained by the index. Low r-squared
   * means the basket is a poor comparable set and the beta should not be
   * leaned on, however tidy the point estimate looks. */
  rSquared: number;
  observations: number;
}

/**
 * Ordinary least-squares beta of an asset against an index, from paired return
 * series. Returns r-squared alongside it because a beta without a fit quality
 * is close to meaningless for this purpose: a comps basket that does not
 * actually explain the asset's moves will still produce a confident-looking
 * number.
 */
export function estimateBeta(assetReturns: number[], indexReturns: number[]): BetaEstimate {
  if (assetReturns.length !== indexReturns.length) {
    throw new Error("estimateBeta requires paired return series of equal length");
  }
  if (assetReturns.length < 2) {
    throw new Error("estimateBeta requires at least 2 observations");
  }

  const assetMean = mean(assetReturns);
  const indexMean = mean(indexReturns);

  let covariance = 0;
  let indexVariance = 0;
  let assetVariance = 0;

  for (let i = 0; i < assetReturns.length; i++) {
    const da = assetReturns[i] - assetMean;
    const di = indexReturns[i] - indexMean;
    covariance += da * di;
    indexVariance += di * di;
    assetVariance += da * da;
  }

  if (indexVariance === 0) throw new Error("index returns have zero variance; beta is undefined");

  const beta = covariance / indexVariance;
  const rSquared =
    assetVariance === 0 ? 0 : (covariance * covariance) / (indexVariance * assetVariance);

  return { beta, rSquared, observations: assetReturns.length };
}

/**
 * The comps adjustment factor, in the exact form the on-chain
 * AnchorRegistry.currentCenter() computes it. Anything off-chain that needs
 * this must call here rather than reimplementing it.
 */
export function compsAdjustmentFactor(
  indexNow: number,
  indexAtAnchor: number,
  betaBps: number,
  maxAdjustmentBps: number
): number {
  if (indexAtAnchor <= 0 || indexNow <= 0) return 1;

  const deltaBps = (indexNow / indexAtAnchor) * BPS - BPS;
  const rawAdjustmentBps = BPS + (betaBps * deltaBps) / BPS;

  const lower = BPS - maxAdjustmentBps;
  const upper = BPS + maxAdjustmentBps;
  const clamped = Math.min(Math.max(rawAdjustmentBps, lower), upper);

  return clamped / BPS;
}
