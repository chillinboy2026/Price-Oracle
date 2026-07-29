import { describe, expect, it } from "vitest";
import { FairPriceEngine, FairPriceEngineConfig } from "../src/engine/FairPriceEngine.js";
import { MarketSession } from "../src/types.js";

const WIDE_OPEN_GUARDRAILS = { maxDeviationBpsLive: 10_000, maxDeviationBpsOffHours: 10_000 };

function baseConfig(overrides: Partial<FairPriceEngineConfig> = {}): FairPriceEngineConfig {
  return {
    guardrails: { maxDeviationBpsLive: 200, maxDeviationBpsOffHours: 50 },
    liveBlendWeight: 0.5,
    offHoursVolatilityBpsPerTick: 5,
    skewInfluenceBps: 20,
    reconciliationSteps: 0,
    ...overrides,
  };
}

describe("FairPriceEngine", () => {
  it("blends toward a live quote but clamps to the LIVE guardrail", () => {
    const engine = new FairPriceEngine(100, baseConfig({ skewInfluenceBps: 0 }), 1_000);
    const result = engine.tick({ liveQuote: { price: 110, timestamp: 1_010 }, inventorySkewBps: 0, now: 1_010 });

    // Raw 50/50 blend of 100 and 110 is 105, a 5% move -- clamped to the 2% LIVE cap.
    expect(result.session).toBe(MarketSession.LIVE);
    expect(result.price).toBeCloseTo(102, 6);
  });

  it("drifts off-hours but clamps to the tighter OFF_HOURS guardrail", () => {
    const engine = new FairPriceEngine(
      100,
      baseConfig({ offHoursVolatilityBpsPerTick: 1000, skewInfluenceBps: 0, random: () => 1 }),
      1_000
    );
    const result = engine.tick({ liveQuote: null, inventorySkewBps: 0, now: 1_010 });

    // A +10% synthetic step is clamped to the 0.5% off-hours cap.
    expect(result.session).toBe(MarketSession.OFF_HOURS);
    expect(result.price).toBeCloseTo(100.5, 6);
  });

  it("nudges price down when traders are net long and up when net short", () => {
    const config = baseConfig({
      guardrails: WIDE_OPEN_GUARDRAILS,
      offHoursVolatilityBpsPerTick: 0,
      skewInfluenceBps: 100,
      random: () => 0.5, // zero synthetic step, isolates the skew effect
    });

    const long = new FairPriceEngine(100, config, 1_000);
    const longResult = long.tick({ liveQuote: null, inventorySkewBps: 5_000, now: 1_010 });
    expect(longResult.price).toBeCloseTo(99.5, 6);

    const short = new FairPriceEngine(100, config, 1_000);
    const shortResult = short.tick({ liveQuote: null, inventorySkewBps: -5_000, now: 1_010 });
    expect(shortResult.price).toBeCloseTo(100.5, 6);
  });

  it("ramps blend aggressiveness gradually over reconciliationSteps after a reopen", () => {
    const config = baseConfig({
      guardrails: WIDE_OPEN_GUARDRAILS,
      liveBlendWeight: 0.8,
      skewInfluenceBps: 0,
      reconciliationSteps: 4,
    });
    const engine = new FairPriceEngine(100, config, 1_000);
    const liveQuote = { price: 200, timestamp: 0 };

    let expectedPrice = 100;
    const expectedWeights = [0.8 / 4, 0.8 / 3, 0.8 / 2, 0.8 / 1];

    for (let i = 0; i < 4; i++) {
      const result = engine.tick({ liveQuote, inventorySkewBps: 0, now: 1_000 + i });
      expectedPrice = expectedPrice * (1 - expectedWeights[i]) + liveQuote.price * expectedWeights[i];
      expect(result.price).toBeCloseTo(expectedPrice, 6);
      expect(result.session).toBe(MarketSession.LIVE);
    }

    // Reconciliation window has elapsed: the next tick uses the full base blend weight.
    const finalResult = engine.tick({ liveQuote, inventorySkewBps: 0, now: 1_010 });
    const expectedFinal = expectedPrice * (1 - 0.8) + liveQuote.price * 0.8;
    expect(finalResult.price).toBeCloseTo(expectedFinal, 6);
  });

  it("syncTo re-anchors state so the next tick blends from the canonical price", () => {
    const engine = new FairPriceEngine(100, baseConfig({ skewInfluenceBps: 0 }), 1_000);
    engine.syncTo(150, 2_000, MarketSession.LIVE, 7n);
    expect(engine.getState().price).toBe(150);
    expect(engine.getState().nonce).toBe(7n);

    const result = engine.tick({ liveQuote: { price: 150, timestamp: 2_010 }, inventorySkewBps: 0, now: 2_010 });
    expect(result.price).toBeCloseTo(150, 6);
    expect(result.nonce).toBe(8n);
  });
});
