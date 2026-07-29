import { describe, expect, it } from "vitest";
import { AnchorBook, AnchorReference } from "../src/anchor/AnchorBook.js";
import { AnchorKind } from "../src/anchor/types.js";
import { FairPriceEngine, FairPriceEngineConfig } from "../src/engine/FairPriceEngine.js";
import { MarketSession } from "../src/types.js";

const DAY = 86_400;
const T0 = 1_800_000_000;

/** Guardrails default to wide here so anchor behavior is isolated; the test
 * that specifically checks the per-update cap still binds sets its own. */
function config(overrides: Partial<FairPriceEngineConfig> = {}): FairPriceEngineConfig {
  return {
    guardrails: { maxDeviationBpsLive: 10_000, maxDeviationBpsOffHours: 10_000 },
    liveBlendWeight: 0.5,
    offHoursVolatilityBpsPerTick: 0,
    skewInfluenceBps: 0,
    reconciliationSteps: 0,
    anchorPullPerTick: 0.25,
    random: () => 0.5, // no synthetic noise, isolating the anchor behavior
    ...overrides,
  };
}

function reference(overrides: Partial<AnchorReference> = {}): AnchorReference {
  return {
    price: 20,
    bandBps: 1_500,
    confidenceBps: 500,
    ageDays: 0,
    kind: AnchorKind.PRICED_ROUND,
    ...overrides,
  };
}

describe("anchor-aware FairPriceEngine", () => {
  it("behaves exactly as before when no anchor is supplied", () => {
    const engine = new FairPriceEngine(100, config(), T0);
    const result = engine.tick({ liveQuote: null, inventorySkewBps: 0, now: T0 + 60 });
    expect(result.price).toBeCloseTo(100, 9);
    expect(result.confidenceBps).toBe(50);
  });

  it("mean-reverts toward the anchor instead of random-walking away", () => {
    const engine = new FairPriceEngine(18, config(), T0);
    const anchor = reference({ price: 20 });

    // Each tick closes 25% of the remaining gap to the anchor.
    const first = engine.tick({ liveQuote: null, inventorySkewBps: 0, now: T0 + 60, anchor });
    expect(first.price).toBeCloseTo(18 + (20 - 18) * 0.25, 6);

    const second = engine.tick({ liveQuote: null, inventorySkewBps: 0, now: T0 + 120, anchor });
    expect(second.price).toBeGreaterThan(first.price);
    expect(second.price).toBeLessThan(20);
  });

  it("converges to the anchor and stays there absent order flow", () => {
    const engine = new FairPriceEngine(15, config(), T0);
    const anchor = reference({ price: 20 });

    for (let i = 0; i < 200; i++) {
      engine.tick({ liveQuote: null, inventorySkewBps: 0, now: T0 + i * 60, anchor });
    }
    expect(engine.getState().price).toBeCloseTo(20, 4);
  });

  it("hard-clamps to the anchor band even under extreme order flow", () => {
    // Enormous skew influence: without the band this would push price far away.
    const engine = new FairPriceEngine(20, config({ skewInfluenceBps: 20_000, anchorPullPerTick: 0 }), T0);
    const anchor = reference({ price: 20, bandBps: 1_500 });

    for (let i = 0; i < 50; i++) {
      engine.tick({ liveQuote: null, inventorySkewBps: -10_000, now: T0 + i * 60, anchor });
    }

    // Band is +/-15% around $20, i.e. [17, 23].
    expect(engine.getState().price).toBeLessThanOrEqual(23 + 1e-9);
    expect(engine.getState().price).toBeCloseTo(23, 6);
  });

  it("lets order flow discover price inside the band, in both directions", () => {
    const anchor = reference({ price: 20, bandBps: 1_500 });
    const engineConfig = config({ skewInfluenceBps: 500, anchorPullPerTick: 0.05 });

    const buyPressure = new FairPriceEngine(20, engineConfig, T0);
    const sellPressure = new FairPriceEngine(20, engineConfig, T0);

    for (let i = 0; i < 30; i++) {
      // Negative skew = traders net short = the vault is long = price pushed up.
      buyPressure.tick({ liveQuote: null, inventorySkewBps: -5_000, now: T0 + i * 60, anchor });
      sellPressure.tick({ liveQuote: null, inventorySkewBps: 5_000, now: T0 + i * 60, anchor });
    }

    expect(buyPressure.getState().price).toBeGreaterThan(20);
    expect(sellPressure.getState().price).toBeLessThan(20);
    // Both remain bounded by real-world evidence.
    expect(buyPressure.getState().price).toBeLessThanOrEqual(23 + 1e-9);
    expect(sellPressure.getState().price).toBeGreaterThanOrEqual(17 - 1e-9);
  });

  it("widens the band as the anchor ages, letting price roam further", () => {
    const book = new AnchorBook({ maxBandBps: 5_000, maxConfidenceBps: 3_000 });
    book.record({
      kind: AnchorKind.PRICED_ROUND,
      pricePerShare: 20,
      shareClass: "COMMON",
      effectiveAt: T0,
      bandBps: 1_500,
    });

    const engineConfig = config({ skewInfluenceBps: 20_000, anchorPullPerTick: 0 });

    function ceilingAt(now: number): number {
      const engine = new FairPriceEngine(20, engineConfig, now);
      const anchor = book.getReference(now)!;
      for (let i = 0; i < 80; i++) {
        engine.tick({ liveQuote: null, inventorySkewBps: -10_000, now: now + i * 60, anchor });
      }
      return engine.getState().price;
    }

    const fresh = ceilingAt(T0);
    const stale = ceilingAt(T0 + 200 * DAY);

    expect(stale).toBeGreaterThan(fresh);
    // Still bounded, just more loosely: stale evidence constrains, it does not pin.
    expect(stale).toBeLessThan(20 * 1.5);
  });

  it("reports confidence from anchor staleness rather than a session constant", () => {
    const engine = new FairPriceEngine(20, config(), T0);

    const fresh = engine.tick({
      liveQuote: null,
      inventorySkewBps: 0,
      now: T0 + 60,
      anchor: reference({ confidenceBps: 500 }),
    });
    expect(fresh.confidenceBps).toBe(500);

    const stale = engine.tick({
      liveQuote: null,
      inventorySkewBps: 0,
      now: T0 + 120,
      anchor: reference({ confidenceBps: 2_400, ageDays: 190 }),
    });
    expect(stale.confidenceBps).toBe(2_400);
  });

  it("still respects the per-update deviation guardrail inside a wide band", () => {
    // Band allows a jump to $40, but the guardrail caps any single update at 2%.
    const engine = new FairPriceEngine(
      20,
      config({
        anchorPullPerTick: 1,
        guardrails: { maxDeviationBpsLive: 200, maxDeviationBpsOffHours: 200 },
      }),
      T0
    );
    const anchor = reference({ price: 40, bandBps: 5_000 });

    const result = engine.tick({ liveQuote: null, inventorySkewBps: 0, now: T0 + 60, anchor });
    expect(result.price).toBeCloseTo(20 * 1.02, 6);
  });

  it("keeps tracking a live quote when one exists, even with an anchor present", () => {
    // Applies to a pre-IPO name that lists: the anchor keeps constraining, but
    // an actual market takes over as the thing being tracked.
    const engine = new FairPriceEngine(20, config({ anchorPullPerTick: 0.25 }), T0);
    const anchor = reference({ price: 20, bandBps: 5_000 });

    const result = engine.tick({
      liveQuote: { price: 22, timestamp: T0 + 60 },
      inventorySkewBps: 0,
      now: T0 + 60,
      anchor,
    });

    expect(result.session).toBe(MarketSession.LIVE);
    expect(result.price).toBeGreaterThan(20);
  });
});
