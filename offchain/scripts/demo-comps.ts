/**
 * Comparables tracking for a pre-IPO software company.
 *
 * The thesis being tested: a pre-IPO mark that tracks public comparables
 * should land close to the eventual IPO price, because IPO pricing is itself
 * largely a comps exercise -- bankers price off the sector's revenue multiple.
 * If the oracle tracks the same multiple, it should converge on the same
 * answer without ever seeing the IPO.
 *
 * This simulates 18 months between a Series D and an IPO, during which the
 * public SaaS basket goes through a drawdown and a recovery, and compares:
 *
 *   - a static anchor (no comps tracking) -- what the price does if you only
 *     ever trust the last financing round
 *   - a comps-tracked anchor -- the model built here
 *   - the "true" fair value, marked continuously off the sector multiple
 *
 * Run with: pnpm --filter ./offchain demo:comps
 */
import { AnchorBook } from "../src/anchor/AnchorBook.js";
import { AnchorKind } from "../src/anchor/types.js";
import { CompsBasket } from "../src/comps/CompsBasket.js";
import { estimateBeta, logReturns } from "../src/comps/beta.js";
import { FairPriceEngine, FairPriceEngineConfig } from "../src/engine/FairPriceEngine.js";
import { mulberry32 } from "../src/util/rng.js";

const DAY = 86_400;
const T0 = Math.floor(Date.UTC(2026, 0, 15) / 1000);

const BETA_BPS = 13_000; // 1.3x the basket
const MAX_COMP_ADJUSTMENT_BPS = 5_000;

const basePrices = { CRM: 250, NOW: 900, DDOG: 120, SNOW: 160 };
const basket = new CompsBasket({
  name: "SAAS",
  constituents: [
    { symbol: "CRM", weight: 3 },
    { symbol: "NOW", weight: 3 },
    { symbol: "DDOG", weight: 2 },
    { symbol: "SNOW", weight: 2 },
  ],
  basePrices,
  minConstituents: 3,
});

/** A plausible 18-month sector path: a drawdown into month 6, a grinding
 * recovery, and a strong final stretch into the IPO window. Values are index
 * levels relative to 1.0 at the Series D. */
function sectorPathAt(day: number): number {
  const t = day / 547;
  const drawdown = -0.32 * Math.exp(-(((t - 0.33) / 0.22) ** 2));
  const recovery = 0.55 * t;
  const wobble = 0.04 * Math.sin(t * 14);
  return 1 + drawdown + recovery + wobble;
}

/** Constituent prices consistent with a given index level, with idiosyncratic
 * dispersion so the basket is doing real work rather than echoing one number. */
function constituentPricesAt(day: number, rng: () => number): Map<string, number> {
  const level = sectorPathAt(day);
  const out = new Map<string, number>();
  for (const [symbol, base] of Object.entries(basePrices)) {
    const idio = 1 + (rng() - 0.5) * 0.06;
    out.set(symbol, base * level * idio);
  }
  return out;
}

const money = (n: number) => `$${n.toFixed(2)}`;

// ---------------------------------------------------------------------------

console.log("=== Estimating beta to the SaaS basket ===\n");

{
  const rng = mulberry32(3);
  const indexSeries: number[] = [];
  const assetSeries: number[] = [];
  let assetPrice = 30;
  for (let day = 0; day <= 400; day += 5) {
    const index = basket.value(constituentPricesAt(day, rng))!.value;
    indexSeries.push(index);
    // The private name's "true" value moves 1.3x the sector, plus idiosyncratic noise.
    const prevIndex = indexSeries.length > 1 ? indexSeries[indexSeries.length - 2] : index;
    assetPrice *= 1 + 1.3 * (index / prevIndex - 1) + (rng() - 0.5) * 0.01;
    assetSeries.push(assetPrice);
  }

  const { beta, rSquared, observations } = estimateBeta(logReturns(assetSeries), logReturns(indexSeries));
  console.log(`  observations: ${observations}`);
  console.log(`  estimated beta: ${beta.toFixed(3)}  (configured on-chain: ${(BETA_BPS / 10_000).toFixed(2)})`);
  console.log(`  r-squared: ${rSquared.toFixed(3)}`);
  console.log("\n  r-squared is reported because a beta without a fit quality is a trap:");
  console.log("  a poor comparables set still yields a confident-looking number.");
}

console.log("\n=== 18 months from Series D to IPO ===\n");

const SERIES_D_COMMON = 30;
const IPO_PRICE = SERIES_D_COMMON * (1 + 1.3 * (sectorPathAt(547) - 1));

const staticBook = new AnchorBook({ maxBandBps: 5_000, maxConfidenceBps: 3_000 });
const compsBook = new AnchorBook({
  maxBandBps: 5_000,
  maxConfidenceBps: 3_000,
  betaBps: BETA_BPS,
  maxCompAdjustmentBps: MAX_COMP_ADJUSTMENT_BPS,
});

for (const book of [staticBook, compsBook]) {
  book.record({
    kind: AnchorKind.PRICED_ROUND,
    pricePerShare: SERIES_D_COMMON,
    shareClass: "COMMON",
    effectiveAt: T0,
    bandBps: 1_500,
    compIndexAtEffective: 1,
    documentHash: "0xseries-d",
  });
}

const engineConfig: FairPriceEngineConfig = {
  guardrails: { maxDeviationBpsLive: 200, maxDeviationBpsOffHours: 200 },
  liveBlendWeight: 0.5,
  offHoursVolatilityBpsPerTick: 4,
  marketPressure: {
    thresholdBps: 1000,
    saturationBps: 3_000,
    marketShareOfBandBps: 6_000,
    maxDisplacementBpsNoAnchor: 100,
  },
  reconciliationSteps: 0,
  anchorPullPerTick: 0.05,
  random: mulberry32(21),
};

const staticEngine = new FairPriceEngine(SERIES_D_COMMON, engineConfig, T0);
const compsEngine = new FairPriceEngine(SERIES_D_COMMON, engineConfig, T0);
const priceRng = mulberry32(88);

console.log("  day   sector   true FV   static-anchor   comps-tracked");
console.log("  ---   ------   -------   -------------   -------------");

for (let day = 0; day <= 547; day++) {
  const now = T0 + day * DAY;
  const index = basket.value(constituentPricesAt(day, priceRng))!.value;
  const trueFairValue = SERIES_D_COMMON * (1 + 1.3 * (sectorPathAt(day) - 1));

  // Traders lean long when the mark looks cheap against fair value and short
  // when it looks rich -- and positive skew (net long / excess demand) raises
  // the price, as a clearing market does.
  const staticSkew = staticEngine.getState().price < trueFairValue ? 4_000 : -4_000;
  const compsSkew = compsEngine.getState().price < trueFairValue ? 4_000 : -4_000;

  staticEngine.tick({
    liveQuote: null,
    inventorySkewBps: staticSkew,
    smoothedSkewBps: staticSkew,
    now,
    anchor: staticBook.getReference(now)!,
  });
  compsEngine.tick({
    liveQuote: null,
    inventorySkewBps: compsSkew,
    smoothedSkewBps: compsSkew,
    now,
    anchor: compsBook.getReference(now, index)!,
  });

  if (day % 60 === 0 || day === 547) {
    console.log(
      `  ${String(day).padStart(3)}   ${sectorPathAt(day).toFixed(3).padStart(6)}   ` +
        `${money(trueFairValue).padStart(7)}   ${money(staticEngine.getState().price).padStart(13)}   ` +
        `${money(compsEngine.getState().price).padStart(13)}`
    );
  }
}

const staticFinal = staticEngine.getState().price;
const compsFinal = compsEngine.getState().price;
const staticErr = Math.abs(staticFinal - IPO_PRICE) / IPO_PRICE;
const compsErr = Math.abs(compsFinal - IPO_PRICE) / IPO_PRICE;

console.log(`\n  IPO prices at ${money(IPO_PRICE)}\n`);
console.log(`  static anchor  ${money(staticFinal).padStart(7)}   off by ${(staticErr * 100).toFixed(1)}%`);
console.log(`  comps-tracked  ${money(compsFinal).padStart(7)}   off by ${(compsErr * 100).toFixed(1)}%`);

console.log("\n  The static anchor is pinned near the Series D price and can only stray");
console.log("  as far as its (slowly widening) band allows -- it has no mechanism to");
console.log("  learn that the sector rerated. The comps-tracked band travels with the");
console.log("  public multiple, so the mark follows the same thing the IPO will be");
console.log("  priced off, and order flow fine-tunes inside that band.");

console.log("\n=== Read this before believing the 0.2% ===\n");
console.log("  This simulation DEFINES true fair value as 1.3x the sector move, and the");
console.log("  model is configured with beta 1.3. The close tracking is therefore partly");
console.log("  circular: it demonstrates that the mechanism works -- the band travels");
console.log("  with comps, order flow converges inside it, the on-chain and off-chain");
console.log("  math agree -- but it does NOT establish that any particular beta is");
console.log("  correct for a real company. Getting beta and the comparable set right is");
console.log("  the actual hard problem, and it is an empirical one this cannot settle.");

console.log("\n=== What comps cannot tell you ===\n");
console.log("  Comps capture sector multiple rerating -- a large part of what moves a");
console.log("  private mark between rounds, and fully observable.");
console.log("  They do NOT capture this company's own execution: a missed year or a");
console.log("  breakout quarter is invisible until the next anchor lands. Note also");
console.log("  that the static anchor above plateaus near $39 rather than reaching its");
console.log("  band ceiling, because mean reversion keeps dragging it back toward a");
console.log("  Series D price that stopped being informative months earlier.");
console.log("  That is why the band still widens with age, and why comps alone are");
console.log(`  capped at +/-${MAX_COMP_ADJUSTMENT_BPS / 100}% of the anchor.`);
