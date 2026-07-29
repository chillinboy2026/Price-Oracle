import { MarketSession } from "../types.js";

export interface GuardrailConfig {
  /** Max move (bps) per update while the reference market is open. */
  maxDeviationBpsLive: number;
  /** Max move (bps) per update while the reference market is closed. Kept
   * tighter than the LIVE bound since there is no independent market to
   * cross-check an off-hours move against. Must match the corresponding
   * PriceOracle.AssetConfig values on-chain, or attestations built here may
   * be rejected by the contract's own (authoritative) guardrail check. */
  maxDeviationBpsOffHours: number;
}

export function maxDeviationForSession(session: MarketSession, config: GuardrailConfig): number {
  return session === MarketSession.LIVE ? config.maxDeviationBpsLive : config.maxDeviationBpsOffHours;
}

export function deviationBps(previous: number, proposed: number): number {
  if (previous === 0) return 0;
  return (Math.abs(proposed - previous) / previous) * 10_000;
}

/**
 * Clamps `proposed` to within `maxDeviationBps` of `previous`. This mirrors
 * PriceOracle._checkDeviation exactly, so an attestation built from this
 * value is never rejected on-chain purely for exceeding the guardrail --
 * the on-chain check remains authoritative, this just avoids wasting a
 * reporter round-trip on a value it would reject.
 */
export function clampToDeviation(previous: number, proposed: number, maxDeviationBps: number): number {
  if (previous <= 0) return proposed;
  const maxDelta = (previous * maxDeviationBps) / 10_000;
  const lower = previous - maxDelta;
  const upper = previous + maxDelta;
  return Math.min(Math.max(proposed, lower), upper);
}
