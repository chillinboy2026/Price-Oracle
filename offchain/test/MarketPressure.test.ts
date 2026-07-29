import { describe, expect, it } from "vitest";
import { MarketPressureConfig, computeMarketPressure } from "../src/engine/MarketPressure.js";

const CONFIG: MarketPressureConfig = {
  thresholdBps: 1_500,
  saturationBps: 3_000,
  marketShareOfBandBps: 6_000,
  maxDisplacementBpsNoAnchor: 100,
};

const BAND = 1_500; // +/-15%

describe("MarketPressure", () => {
  describe("conviction threshold", () => {
    it("produces exactly zero displacement below the threshold", () => {
      for (const skew of [0, 500, 1_000, 1_499]) {
        const r = computeMarketPressure(skew, CONFIG, BAND);
        expect(r.displacementBps).toBe(0);
        expect(r.effectivePressureBps).toBe(0);
      }
    });

    it("treats the threshold symmetrically in both directions", () => {
      expect(computeMarketPressure(-1_400, CONFIG, BAND).displacementBps).toBe(0);
      expect(computeMarketPressure(1_400, CONFIG, BAND).displacementBps).toBe(0);
    });

    it("starts moving once conviction clears the threshold", () => {
      const r = computeMarketPressure(2_000, CONFIG, BAND);
      expect(r.effectivePressureBps).toBe(500);
      expect(r.displacementBps).toBeGreaterThan(0);
    });

    it("measures pressure past the threshold, not from zero", () => {
      // 3000 of raw skew is 1500 of conviction, same as 3000 raw would give
      // under a zero threshold with half the saturation.
      expect(computeMarketPressure(3_000, CONFIG, BAND).effectivePressureBps).toBe(1_500);
    });
  });

  describe("direction", () => {
    it("raises price on excess demand and lowers it on excess supply", () => {
      expect(computeMarketPressure(5_000, CONFIG, BAND).displacementBps).toBeGreaterThan(0);
      expect(computeMarketPressure(-5_000, CONFIG, BAND).displacementBps).toBeLessThan(0);
    });

    it("is exactly antisymmetric", () => {
      const up = computeMarketPressure(5_000, CONFIG, BAND).displacementBps;
      const down = computeMarketPressure(-5_000, CONFIG, BAND).displacementBps;
      expect(up).toBeCloseTo(-down, 12);
    });
  });

  describe("saturation", () => {
    it("increases monotonically with conviction", () => {
      let previous = 0;
      for (const skew of [2_000, 3_000, 4_500, 6_000, 9_000, 20_000]) {
        const d = computeMarketPressure(skew, CONFIG, BAND).displacementBps;
        expect(d).toBeGreaterThan(previous);
        previous = d;
      }
    });

    it("shows diminishing returns: each additional unit of conviction buys less", () => {
      const at = (s: number) => computeMarketPressure(s, CONFIG, BAND).displacementBps;
      const firstStep = at(3_000) - at(1_500);
      const secondStep = at(4_500) - at(3_000);
      const thirdStep = at(6_000) - at(4_500);

      expect(secondStep).toBeLessThan(firstStep);
      expect(thirdStep).toBeLessThan(secondStep);
    });

    it("approaches but does not reach the full room at realistic conviction", () => {
      // Skew is bounded well below this in practice: the vault caps
      // getInventorySkewBps at maxFeeBps.
      const r = computeMarketPressure(10_000, CONFIG, BAND);
      expect(r.utilization).toBeLessThan(1);
      expect(Math.abs(r.displacementBps)).toBeLessThan(r.roomBps);
    });

    it("still cannot pin against the band even at absurd conviction", () => {
      // tanh saturates to exactly 1 in float64 past roughly x=19, so the
      // asymptote alone is not what keeps price off the band edge -- the room
      // cap is. That is the guarantee worth asserting, and it holds regardless
      // of how extreme the input gets.
      const r = computeMarketPressure(1_000_000, CONFIG, BAND);
      expect(Math.abs(r.displacementBps)).toBeLessThanOrEqual(r.roomBps);
      expect(r.roomBps).toBeLessThan(BAND);
    });
  });

  describe("bounded share of the band", () => {
    it("caps room at the configured share of the band", () => {
      const r = computeMarketPressure(50_000, CONFIG, BAND);
      expect(r.roomBps).toBe(900); // 60% of 1500
      // 9% of price, well inside the 15% band -- evidence keeps majority control.
      expect(Math.abs(r.displacementBps)).toBeLessThan(900);
    });

    it("grants more room as the band widens with anchor age", () => {
      const fresh = computeMarketPressure(9_000, CONFIG, 1_500);
      const stale = computeMarketPressure(9_000, CONFIG, 5_000);

      expect(stale.roomBps).toBeGreaterThan(fresh.roomBps);
      expect(Math.abs(stale.displacementBps)).toBeGreaterThan(Math.abs(fresh.displacementBps));
      // Same conviction, same fraction of the available room used.
      expect(stale.utilization).toBeCloseTo(fresh.utilization, 12);
    });

    it("falls back to the no-anchor cap when there is no band", () => {
      const r = computeMarketPressure(50_000, CONFIG, undefined);
      expect(r.roomBps).toBe(100);
      expect(Math.abs(r.displacementBps)).toBeLessThan(100);
    });

    it("produces nothing when the market is allotted no room", () => {
      const r = computeMarketPressure(50_000, { ...CONFIG, marketShareOfBandBps: 0 }, BAND);
      expect(r.displacementBps).toBe(0);
    });
  });
});
