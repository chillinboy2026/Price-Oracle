/**
 * How market sentiment and comparables share control of the price.
 *
 * The design question: hype and despair around a pre-IPO name are real
 * information and should move the mark -- but they must not be able to take it
 * over, and a brief flurry of one-sided flow should not move it at all.
 *
 * Three mechanisms do that work, in order:
 *
 *   1. On-chain skew smoothing  -- only *sustained* positioning is even visible
 *   2. Conviction threshold     -- below it, nothing moves
 *   3. Saturating, capped room  -- more conviction always moves price, by ever
 *                                  less, and never past a set share of the band
 *
 * Run with: pnpm --filter ./offchain demo:hype
 */
import { AnchorBook } from "../src/anchor/AnchorBook.js";
import { AnchorKind } from "../src/anchor/types.js";
import { FairPriceEngine, FairPriceEngineConfig } from "../src/engine/FairPriceEngine.js";
import { computeMarketPressure } from "../src/engine/MarketPressure.js";
import { mulberry32 } from "../src/util/rng.js";

const DAY = 86_400;
const HOUR = 3_600;
const T0 = Math.floor(Date.UTC(2026, 0, 15) / 1000);
const ANCHOR_PRICE = 30;

const PRESSURE = {
  thresholdBps: 1_500,
  saturationBps: 3_000,
  marketShareOfBandBps: 6_000,
  maxDisplacementBpsNoAnchor: 100,
};

const engineConfig: FairPriceEngineConfig = {
  guardrails: { maxDeviationBpsLive: 200, maxDeviationBpsOffHours: 200 },
  liveBlendWeight: 0.5,
  offHoursVolatilityBpsPerTick: 2,
  marketPressure: PRESSURE,
  reconciliationSteps: 0,
  anchorPullPerTick: 0.05,
  random: mulberry32(5),
};

function book() {
  const b = new AnchorBook({ maxBandBps: 5_000, maxConfidenceBps: 3_000 });
  b.record({
    kind: AnchorKind.PRICED_ROUND,
    pricePerShare: ANCHOR_PRICE,
    shareClass: "COMMON",
    effectiveAt: T0,
    bandBps: 1_500,
  });
  return b;
}

function settle(skewBps: number, atDay = 30, ticks = 600): number {
  const b = book();
  const now = T0 + atDay * DAY;
  const engine = new FairPriceEngine(ANCHOR_PRICE, engineConfig, now);
  for (let i = 0; i < ticks; i++) {
    engine.tick({
      liveQuote: null,
      inventorySkewBps: skewBps,
      smoothedSkewBps: skewBps,
      now: now + i * HOUR,
      anchor: b.getReference(now)!,
    });
  }
  return engine.getState().price;
}

const pct = (p: number) => `${(((p - ANCHOR_PRICE) / ANCHOR_PRICE) * 100).toFixed(2)}%`;

console.log(`=== The conviction threshold (anchor $${ANCHOR_PRICE}, band +/-15% = [$25.50, $34.50]) ===\n`);
console.log("  sustained skew   settled price   vs anchor   note");
for (const skew of [0, 500, 1_000, 1_500, 1_600, 2_000, 3_000]) {
  const p = settle(skew);
  // The threshold is exclusive: at exactly thresholdBps the contribution is
  // still zero. Sub-threshold rows show a few bps of movement, which is the
  // off-hours drift term, not order flow.
  const note =
    skew <= PRESSURE.thresholdBps ? "below threshold -- only drift" : "conviction clears the bar";
  console.log(`  ${String(skew).padStart(14)}   ${("$" + p.toFixed(4)).padStart(13)}   ${pct(p).padStart(9)}   ${note}`);
}

console.log("\n=== Saturation: more conviction always moves price, by ever less ===\n");
console.log("  sustained skew   settled price   vs anchor   step vs previous");
let previous: number | null = null;
for (const skew of [2_000, 3_000, 4_500, 6_000, 9_000, 10_000]) {
  const p = settle(skew);
  const step = previous === null ? "" : `+${(p - previous).toFixed(4)}`;
  console.log(`  ${String(skew).padStart(14)}   ${("$" + p.toFixed(4)).padStart(13)}   ${pct(p).padStart(9)}   ${step.padStart(9)}`);
  previous = p;
}
console.log("\n  Every increase still moves the price -- the market is never silenced --");
console.log("  but each additional unit of conviction buys less than the one before.");

console.log("\n=== Comps and anchors keep majority control ===\n");
{
  const maxed = computeMarketPressure(10_000, PRESSURE, 1_500);
  console.log(`  band half-width:            ${(1_500 / 100).toFixed(1)}%`);
  console.log(`  market's share of it:       ${(PRESSURE.marketShareOfBandBps / 100).toFixed(0)}%`);
  console.log(`  so max sentiment swing:     +/-${(maxed.roomBps / 100).toFixed(2)}%`);
  console.log(`  actually used at max skew:  ${((maxed.displacementBps / 100)).toFixed(2)}%  (${(maxed.utilization * 100).toFixed(1)}% of room)`);
  console.log("\n  Price can never pin against the band, because sentiment is capped");
  console.log("  strictly inside it. Evidence always retains the majority vote.");
}

console.log("\n=== A stale anchor cedes more ground to the market ===\n");
console.log("  days since anchor   band half-width   max sentiment swing   settled at max skew");
for (const day of [30, 180, 365, 1_095]) {
  const ref = book().getReference(T0 + day * DAY)!;
  const p = settle(10_000, day);
  const room = computeMarketPressure(10_000, PRESSURE, ref.bandBps);
  console.log(
    `  ${String(day).padStart(17)}   ${((ref.bandBps / 100).toFixed(1) + "%").padStart(15)}   ` +
      `${("+/-" + (room.roomBps / 100).toFixed(2) + "%").padStart(19)}   ${("$" + p.toFixed(2)).padStart(19)}`
  );
}
console.log("\n  As real-world evidence ages, the market earns proportionally more say.");
console.log("  That is the intended trade: the less current the last valuation event,");
console.log("  the more weight belongs with whoever is actually willing to trade.");

console.log("\n=== Sentiment reverses cleanly ===\n");
for (const [label, skew] of [
  ["euphoria", 9_000],
  ["mild optimism", 2_500],
  ["neutral", 0],
  ["mild pessimism", -2_500],
  ["capitulation", -9_000],
] as const) {
  const p = settle(skew);
  console.log(`  ${label.padEnd(16)} skew ${String(skew).padStart(6)}  ->  $${p.toFixed(4)}  (${pct(p)})`);
}

console.log("\n=== What this does not do ===\n");
console.log("  Smoothing is on-chain (MarketMakerVault.getSmoothedSkewBps) so every");
console.log("  reporter reads one objective number and can threshold-sign the same");
console.log("  price. But a determined actor who can hold a large one-sided position");
console.log("  for weeks CAN move the mark by up to the room above -- that is the");
console.log("  mechanism working as designed, not a bypass of it. What bounds the");
console.log("  damage is the cap, and the cost of financing that position against a");
console.log("  fee that rises the more one-sided the book becomes.");
