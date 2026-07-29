/**
 * Walks the pre-IPO anchor lifecycle end to end:
 *
 *   headline round valuation -> cap-table waterfall -> common price per share
 *   -> anchor recorded -> band derived -> engine prices inside the band
 *   -> band widens as the anchor ages -> new anchor resets it
 *
 * Run with: pnpm --filter ./offchain demo:preipo
 */
import { expectedCommonPrice, preferenceOverhang, preferredPricePerShare, waterfall } from "../src/anchor/capTable.js";
import { AnchorBook } from "../src/anchor/AnchorBook.js";
import { AnchorKind, CapTable } from "../src/anchor/types.js";
import { FairPriceEngine, FairPriceEngineConfig } from "../src/engine/FairPriceEngine.js";
import { mulberry32 } from "../src/util/rng.js";

const DAY = 86_400;
const T0 = Math.floor(Date.UTC(2026, 0, 15) / 1000);

const capTable: CapTable = {
  commonShares: 50_000_000,
  preferred: [
    { name: "Series A", shares: 10_000_000, issuePrice: 1, multiple: 1, participating: false, seniority: 1 },
    { name: "Series B", shares: 10_000_000, issuePrice: 5, multiple: 1, participating: false, seniority: 1 },
    { name: "Series C", shares: 10_000_000, issuePrice: 20, multiple: 1, participating: false, seniority: 1 },
  ],
  optionsOutstanding: 12_000_000,
  optionPoolUnissued: 7_000_000,
  warrants: 1_000_000,
};

function money(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}bn`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}m`;
  return `$${n.toFixed(2)}`;
}

console.log("=== 1. Turning a headline valuation into a price ===\n");

const postMoney = 3_000_000_000;
const headline = preferredPricePerShare(postMoney, capTable);
const commonAtRound = waterfall(postMoney, capTable).commonPricePerShare;

console.log(`  Series D priced at ${money(postMoney)} post-money`);
console.log(`  Fully diluted shares:      100,000,000`);
console.log(`  Preference overhang:       ${money(preferenceOverhang(capTable))}`);
console.log(`  Headline price/share:      $${headline.toFixed(4)}  <- prices PREFERRED`);
console.log(`  Common at that valuation:  $${commonAtRound.toFixed(4)}`);
console.log(`\n  They coincide here, and that is the point: ${money(postMoney)} clears the`);
console.log(`  ${money(preferenceOverhang(capTable))} stack comfortably, so every series converts and`);
console.log("  shares pro rata. The preference only bites lower down:");

for (const v of [1_000_000_000, 500_000_000, 250_000_000]) {
  const h = preferredPricePerShare(v, capTable);
  const c = waterfall(v, capTable).commonPricePerShare;
  console.log(
    `    exit ${money(v).padStart(8)}  headline $${h.toFixed(2).padStart(6)}  common $${c.toFixed(2).padStart(6)}  ` +
      `(${((c / h) * 100).toFixed(0)}% of headline)`
  );
}

console.log("\n  So common's value is set by the *distribution* of outcomes, not one number.");
console.log("  Averaging the waterfall across scenarios captures that asymmetry:");
const scenarios = [
  { exitValue: 8_000_000_000, probability: 0.2, label: "strong IPO" },
  { exitValue: 3_000_000_000, probability: 0.45, label: "flat" },
  { exitValue: 1_000_000_000, probability: 0.25, label: "soft" },
  { exitValue: 300_000_000, probability: 0.1, label: "distressed" },
];
for (const s of scenarios) {
  const price = waterfall(s.exitValue, capTable).commonPricePerShare;
  console.log(
    `    ${(s.probability * 100).toFixed(0).padStart(3)}%  ${s.label.padEnd(11)} exit ${money(s.exitValue).padStart(8)} -> common $${price.toFixed(4)}`
  );
}
const expected = expectedCommonPrice(scenarios, capTable, 2_000);
console.log(`  Probability-weighted, 20% DLOM: $${expected.toFixed(4)}`);
console.log(`  (a real 409A would backsolve an option pricing model; this is a stand-in)`);

console.log("\n=== 2. Anchor the oracle to that common price ===\n");

const book = new AnchorBook({ maxBandBps: 5_000, maxConfidenceBps: 3_000 });
book.record({
  kind: AnchorKind.PRICED_ROUND,
  pricePerShare: commonAtRound,
  shareClass: "COMMON",
  effectiveAt: T0,
  impliedValuation: postMoney,
  bandBps: 1_500,
  documentHash: "0xseries-d-term-sheet",
});

for (const days of [0, 30, 180, 365, 1095]) {
  const ref = book.getReference(T0 + days * DAY)!;
  const band = book.getBand(T0 + days * DAY)!;
  console.log(
    `  +${String(days).padStart(4)}d  anchor $${ref.price.toFixed(4)}  band +/-${(ref.bandBps / 100).toFixed(1).padStart(5)}%  ` +
      `[$${band.lower.toFixed(2)}, $${band.upper.toFixed(2)}]  confidence +/-${(ref.confidenceBps / 100).toFixed(1)}%`
  );
}
console.log("\n  The anchor price never moves -- the round happened at the price it happened at.");
console.log("  Only its authority decays, so the band widens and order flow gets more room.");

console.log("\n=== 3. Order flow discovers price inside the band ===\n");

const engineConfig: FairPriceEngineConfig = {
  guardrails: { maxDeviationBpsLive: 200, maxDeviationBpsOffHours: 200 },
  liveBlendWeight: 0.5,
  offHoursVolatilityBpsPerTick: 3,
  skewInfluenceBps: 400,
  reconciliationSteps: 0,
  anchorPullPerTick: 0.02,
  random: mulberry32(7),
};

function run(label: string, skewBps: number, startDay: number, ticks = 400): number {
  const now = T0 + startDay * DAY;
  const engine = new FairPriceEngine(commonAtRound, engineConfig, now);
  for (let i = 0; i < ticks; i++) {
    engine.tick({
      liveQuote: null,
      inventorySkewBps: skewBps,
      now: now + i * 3600,
      anchor: book.getReference(now)!,
    });
  }
  const price = engine.getState().price;
  const band = book.getBand(now)!;
  console.log(
    `  ${label.padEnd(28)} -> $${price.toFixed(4)}  (band [$${band.lower.toFixed(2)}, $${band.upper.toFixed(2)}])`
  );
  return price;
}

console.log("  30 days after the round:");
run("no pressure", 0, 30);
run("sustained buying pressure", -8_000, 30);
run("sustained selling pressure", 8_000, 30);

console.log("\n  Two years later, same pressure, wider band:");
run("sustained buying pressure", -8_000, 730);
run("sustained selling pressure", 8_000, 730);

console.log("\n=== 4. A new anchor resets the band ===\n");

const tenderPrice = commonAtRound * 1.6;
book.record({
  kind: AnchorKind.TENDER_OFFER,
  pricePerShare: tenderPrice,
  shareClass: "COMMON",
  effectiveAt: T0 + 800 * DAY,
  bandBps: 1_500,
  documentHash: "0xtender-offer-notice",
});

const before = book.getBand(T0 + 799 * DAY)!;
const after = book.getBand(T0 + 801 * DAY)!;
console.log(`  Day 799 (stale round):  [$${before.lower.toFixed(2)}, $${before.upper.toFixed(2)}]`);
console.log(`  Day 801 (fresh tender): [$${after.lower.toFixed(2)}, $${after.upper.toFixed(2)}]`);
console.log(`\n  A $${tenderPrice.toFixed(2)} tender both repriced the asset and re-tightened the band.`);
console.log("  On-chain this is one recordAnchor() call, threshold-attested, with the");
console.log("  tender notice's document hash stored alongside it -- and PriceOracle will");
console.log("  now reject any published price outside the new bounds.");
