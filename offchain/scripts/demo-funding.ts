/**
 * What it costs to hold the price away from its evidence-derived centre.
 *
 * The displacement cap answers "how far can sentiment move the mark". Funding
 * answers the question that actually determines whether anyone does it: "and
 * what does holding it there cost per day".
 *
 * Without funding, a large one-sided position is a free option -- you pay the
 * open and close fee once, and then hold the mark displaced indefinitely at no
 * further cost. Funding converts that into a running bill proportional to how
 * crowded the book is, which is what makes sustained manipulation expensive
 * rather than merely bounded.
 *
 * The arithmetic below mirrors MarketMakerVault and MarketPressure exactly.
 *
 * Run with: pnpm --filter ./offchain demo:funding
 */
import { computeMarketPressure } from "../src/engine/MarketPressure.js";

const BPS = 10_000;

// Vault + pressure parameters, matching the defaults used elsewhere.
const POOL = 10_000_000; // MM liquidity, quote token
const SKEW_SENSITIVITY_BPS = 10_000;
const FUNDING_COEFFICIENT_BPS = 1_000; // 10% of skew becomes the daily rate
const MAX_FUNDING_RATE_BPS_PER_DAY = 200; // 2%/day ceiling
const BASE_FEE_BPS = 100;

const PRESSURE = {
  thresholdBps: 1_500,
  saturationBps: 3_000,
  marketShareOfBandBps: 6_000,
  maxDisplacementBpsNoAnchor: 100,
};
const BAND_BPS = 1_500;
const ROOM_BPS = (BAND_BPS * PRESSURE.marketShareOfBandBps) / BPS;

/** Smoothed skew required to hold a given displacement -- the inverse of the
 * tanh in computeMarketPressure. */
function skewForDisplacement(displacementBps: number): number | null {
  const utilization = displacementBps / ROOM_BPS;
  if (utilization >= 1) return null; // unreachable: the cap is a hard ceiling
  return PRESSURE.thresholdBps + PRESSURE.saturationBps * Math.atanh(utilization);
}

/** MarketMakerVault.getInventorySkewBps inverted: the net notional needed to
 * produce a given skew against this pool. */
function notionalForSkew(skewBps: number): number {
  return (skewBps / SKEW_SENSITIVITY_BPS) * POOL;
}

/** MarketMakerVault.fundingRateForSkew. */
function fundingRateBpsPerDay(skewBps: number): number {
  const raw = (skewBps * FUNDING_COEFFICIENT_BPS) / BPS;
  return Math.min(Math.abs(raw), MAX_FUNDING_RATE_BPS_PER_DAY) * Math.sign(raw);
}

const money = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}m` : `$${Math.round(n).toLocaleString("en-US")}`;

console.log("=== The cost of holding the mark displaced ===\n");
console.log(`  MM pool: ${money(POOL)}   band: +/-${BAND_BPS / 100}%   market's room: +/-${ROOM_BPS / 100}%\n`);
console.log("  target push   required skew   net position   funding/day   cost/day   cost/30d");
console.log("  -----------   -------------   ------------   -----------   --------   --------");

for (const displacementBps of [50, 100, 200, 300, 450, 600, 750, 810, 855]) {
  const skew = skewForDisplacement(displacementBps);
  if (skew === null) continue;

  const notional = notionalForSkew(skew);
  const rate = fundingRateBpsPerDay(skew);
  const costPerDay = (notional * rate) / BPS;

  console.log(
    `  ${(`+${(displacementBps / 100).toFixed(2)}%`).padStart(11)}   ` +
      `${skew.toFixed(0).padStart(13)}   ${money(notional).padStart(12)}   ` +
      `${(rate / 100).toFixed(2).padStart(10)}%   ${money(costPerDay).padStart(8)}   ${money(costPerDay * 30).padStart(8)}`
  );
}

console.log(`\n  The cap at +/-${ROOM_BPS / 100}% is unreachable at any finite cost: displacement`);
console.log("  approaches it asymptotically, so the last fraction of a percent costs");
console.log("  unboundedly more than the first.");

console.log("\n=== Why the ceiling on the funding rate matters ===\n");
for (const skew of [1_000, 2_000, 3_000, 5_000, 10_000]) {
  const raw = (skew * FUNDING_COEFFICIENT_BPS) / BPS;
  const applied = fundingRateBpsPerDay(skew);
  const capped = applied < raw ? "  <- capped" : "";
  console.log(
    `  skew ${String(skew).padStart(6)}   uncapped ${(raw / 100).toFixed(2).padStart(6)}%/day   ` +
      `applied ${(applied / 100).toFixed(2).padStart(5)}%/day${capped}`
  );
}
console.log("\n  The cap keeps funding a carry cost rather than a second liquidation");
console.log("  engine. Past it, extra crowding raises the total bill only through");
console.log("  position size, not through the rate.");

console.log("\n=== Who receives it ===\n");
{
  const skew = skewForDisplacement(450)!;
  const longNotional = notionalForSkew(skew);
  // Suppose a balancing short of a quarter the size leans against the crowd.
  const shortNotional = longNotional * 0.25;
  const rate = fundingRateBpsPerDay(skew);

  const longPays = (longNotional * rate) / BPS;
  const shortReceives = (shortNotional * rate) / BPS;

  console.log(`  crowded longs  ${money(longNotional).padStart(9)}  pay      ${money(longPays)}/day`);
  console.log(`  balancing short${money(shortNotional).padStart(9)}  receives ${money(shortReceives)}/day`);
  console.log(`  market maker                 keeps    ${money(longPays - shortReceives)}/day`);
  console.log("\n  The surplus is netNotional x rate, and it accrues to the market maker");
  console.log("  because the MM is the residual counterparty carrying that net exposure.");
  console.log("  No explicit split is needed: settling each position against pooled");
  console.log("  liquidity produces this automatically.");
}

console.log("\n=== Against the one-off cost of getting in ===\n");
{
  const skew = skewForDisplacement(450)!;
  const notional = notionalForSkew(skew);
  const roundTripFee = (notional * BASE_FEE_BPS * 2) / BPS;
  const dailyCarry = (notional * fundingRateBpsPerDay(skew)) / BPS;

  console.log(`  round-trip fee to establish the position:  ${money(roundTripFee)}`);
  console.log(`  carry to hold it, per day:                 ${money(dailyCarry)}`);
  console.log(`  days until carry exceeds the entry cost:   ${(roundTripFee / dailyCarry).toFixed(1)}`);
  console.log("\n  That ratio is the point. Without funding the entry fee is the whole");
  console.log("  cost and the displacement is then free to maintain forever. With it,");
  console.log("  holding the mark displaced becomes the dominant expense within days.");
}

console.log("\n=== Honest limits ===\n");
console.log("  - Funding raises the cost of manipulation; it does not make it");
console.log("    impossible. An actor who values the displaced mark more than the");
console.log("    carry will still pay it.");
console.log("  - These figures scale with pool size. A thinly-funded vault is cheap");
console.log("    to push, because the same skew needs less absolute notional.");
console.log("  - The rate responds to *smoothed* skew, so the bill ramps in over the");
console.log("    smoothing window rather than starting at full strength.");
