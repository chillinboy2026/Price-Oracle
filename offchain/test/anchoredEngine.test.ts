import { describe, expect, it } from "vitest";
import { AnchorBook, AnchorReference } from "../src/anchor/AnchorBook.js";
import { AnchorKind } from "../src/anchor/types.js";
import { FairPriceEngine, FairPriceEngineConfig } from "../src/engine/FairPriceEngine.js";
import { MarketSession } from "../src/types.js";

const DAY = 86_400;
const T0 = 1_800_000_000;

/** Threshold above any skew used here, so tests that isolate anchor behaviour
 * see no order-flow contribution at all. */
const NO_PRESSURE = {
  thresholdBps: 1_000_000,
  saturationBps: 3_000,
  marketShareOfBandBps: 6_000,
  maxDisplacementBpsNoAnchor: 0,
};

/** Realistic pressure config for the order-flow tests. */
const PRESSURE = {
  thresholdBps: 1_500,
  saturationBps: 3_000,
  marketShareOfBandBps: 6_000,
  maxDisplacementBpsNoAnchor: 100,
};

/** Guardrails default to wide here so anchor behavior is isolated; the test
 * that specifically checks the per-update cap still binds sets its own. */
function config(overrides: Partial<FairPriceEngineConfig> = {}): FairPriceEngineConfig {
  return {
    guardrails: { maxDeviationBpsLive: 10_000, maxDeviationBpsOffHours: 10_000 },
    liveBlendWeight: 0.5,
    offHoursVolatilityBpsPerTick: 0,
    marketPressure: NO_PRESSURE,
    reconciliationSteps: 0,
    anchorPullPerTick: 0.25,
    random: () => 0.5, // no synthetic noise, isolating the anchor behavior
    ...overrides,
  };
}

function reference(overrides: Partial<AnchorReference> = {}): AnchorReference {
  const price = overrides.price ?? 20;
  return {
    price,
    anchorPrice: price,
    compAdjustment: 1,
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

  it("keeps order flow strictly inside the band, approaching it but never pinning", () => {
    // Overwhelming, sustained demand. Under the old tug-of-war model this
    // pinned flat against the band edge; displacement is capped at a share of
    // the band, so the edge is approached and never reached.
    const engine = new FairPriceEngine(20, config({ marketPressure: PRESSURE, anchorPullPerTick: 0.2 }), T0);
    const anchor = reference({ price: 20, bandBps: 1_500 });

    for (let i = 0; i < 400; i++) {
      engine.tick({ liveQuote: null, inventorySkewBps: 10_000, smoothedSkewBps: 10_000, now: T0 + i * 60, anchor });
    }

    const price = engine.getState().price;
    expect(price).toBeGreaterThan(20);
    expect(price).toBeLessThan(23); // strictly inside [17, 23]
    // Comps/anchor retain majority control: 60% of a 15% band is 9%.
    expect(price).toBeLessThanOrEqual(20 * 1.09 + 1e-6);
  });

  it("gives more conviction a higher price, rather than saturating at the band", () => {
    const anchor = reference({ price: 20, bandBps: 1_500 });
    const engineConfig = config({ marketPressure: PRESSURE, anchorPullPerTick: 0.2 });

    function settle(skewBps: number): number {
      const engine = new FairPriceEngine(20, engineConfig, T0);
      for (let i = 0; i < 400; i++) {
        engine.tick({ liveQuote: null, inventorySkewBps: skewBps, smoothedSkewBps: skewBps, now: T0 + i * 60, anchor });
      }
      return engine.getState().price;
    }

    const mild = settle(2_500);
    const strong = settle(4_500);
    const extreme = settle(9_000);

    // Each step up in conviction still moves price -- the old model was flat
    // above ~3000bps because it pinned.
    expect(strong).toBeGreaterThan(mild);
    expect(extreme).toBeGreaterThan(strong);
    // ...but with diminishing returns: doubling conviction does not double the move.
    expect(extreme - strong).toBeLessThan(strong - mild);
  });

  it("ignores order flow that fails to clear the conviction threshold", () => {
    const anchor = reference({ price: 20, bandBps: 1_500 });
    const engine = new FairPriceEngine(20, config({ marketPressure: PRESSURE, anchorPullPerTick: 0.2 }), T0);

    // Below thresholdBps: real positioning, but not sustained conviction.
    for (let i = 0; i < 200; i++) {
      engine.tick({ liveQuote: null, inventorySkewBps: 1_400, smoothedSkewBps: 1_400, now: T0 + i * 60, anchor });
    }
    expect(engine.getState().price).toBeCloseTo(20, 6);
  });

  it("lets order flow discover price inside the band, in both directions", () => {
    const anchor = reference({ price: 20, bandBps: 1_500 });
    const engineConfig = config({ marketPressure: PRESSURE, anchorPullPerTick: 0.05 });

    const buyPressure = new FairPriceEngine(20, engineConfig, T0);
    const sellPressure = new FairPriceEngine(20, engineConfig, T0);

    for (let i = 0; i < 200; i++) {
      // Positive skew = traders net long = excess demand = price up.
      buyPressure.tick({ liveQuote: null, inventorySkewBps: 5_000, smoothedSkewBps: 5_000, now: T0 + i * 60, anchor });
      sellPressure.tick({ liveQuote: null, inventorySkewBps: -5_000, smoothedSkewBps: -5_000, now: T0 + i * 60, anchor });
    }

    expect(buyPressure.getState().price).toBeGreaterThan(20);
    expect(sellPressure.getState().price).toBeLessThan(20);
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

    const engineConfig = config({ marketPressure: PRESSURE, anchorPullPerTick: 0.2 });

    function ceilingAt(now: number): number {
      const engine = new FairPriceEngine(20, engineConfig, now);
      const anchor = book.getReference(now)!;
      for (let i = 0; i < 300; i++) {
        engine.tick({ liveQuote: null, inventorySkewBps: 10_000, smoothedSkewBps: 10_000, now: now + i * 60, anchor });
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
