import { describe, expect, it } from "vitest";
import { CompsBasket } from "../src/comps/CompsBasket.js";
import { compsAdjustmentFactor, estimateBeta, logReturns } from "../src/comps/beta.js";
import { AnchorBook } from "../src/anchor/AnchorBook.js";
import { AnchorKind } from "../src/anchor/types.js";
import { mulberry32 } from "../src/util/rng.js";

const T0 = 1_800_000_000;
const DAY = 86_400;

function saasBasket() {
  return new CompsBasket({
    name: "SAAS",
    constituents: [
      { symbol: "CRM", weight: 3 },
      { symbol: "NOW", weight: 3 },
      { symbol: "DDOG", weight: 2 },
      { symbol: "SNOW", weight: 2 },
    ],
    basePrices: { CRM: 250, NOW: 900, DDOG: 120, SNOW: 160 },
    minConstituents: 3,
  });
}

function prices(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

describe("CompsBasket", () => {
  it("starts at exactly 1.0 at base prices", () => {
    const index = saasBasket().value(prices({ CRM: 250, NOW: 900, DDOG: 120, SNOW: 160 }))!;
    expect(index.value).toBeCloseTo(1, 12);
    expect(index.contributors).toHaveLength(4);
    expect(index.coveredWeight).toBeCloseTo(1, 12);
  });

  it("is unaffected by differences in absolute share price", () => {
    // Every name up 10%: the index is up 10% regardless of the $900 vs $120 gap.
    const index = saasBasket().value(prices({ CRM: 275, NOW: 990, DDOG: 132, SNOW: 176 }))!;
    expect(index.value).toBeCloseTo(1.1, 12);
  });

  it("weights constituents as configured", () => {
    // Only the two 30%-weight names move, +20% each: 0.6 * 0.2 = +12%.
    const index = saasBasket().value(prices({ CRM: 300, NOW: 1080, DDOG: 120, SNOW: 160 }))!;
    expect(index.value).toBeCloseTo(1.12, 12);
  });

  it("renormalizes when a constituent's price is missing", () => {
    // SNOW drops out; the remaining three are all +10%, so the index is +10%
    // rather than dipping because coverage fell.
    const index = saasBasket().value(prices({ CRM: 275, NOW: 990, DDOG: 132 }))!;
    expect(index.value).toBeCloseTo(1.1, 12);
    expect(index.contributors).toEqual(["CRM", "NOW", "DDOG"]);
    expect(index.coveredWeight).toBeCloseTo(0.8, 12);
  });

  it("reports nothing below the minimum constituent count", () => {
    expect(saasBasket().value(prices({ CRM: 275, NOW: 990 }))).toBeNull();
  });

  it("ignores non-positive or non-finite constituent prices", () => {
    const index = saasBasket().value(prices({ CRM: 275, NOW: 990, DDOG: 132, SNOW: 0 }))!;
    expect(index.contributors).not.toContain("SNOW");
    expect(index.value).toBeCloseTo(1.1, 12);
  });

  it("rejects a basket missing a base price or with a non-positive weight", () => {
    expect(
      () =>
        new CompsBasket({
          name: "bad",
          constituents: [{ symbol: "CRM", weight: 1 }],
          basePrices: {},
          minConstituents: 1,
        })
    ).toThrow(/base price/);

    expect(
      () =>
        new CompsBasket({
          name: "bad",
          constituents: [{ symbol: "CRM", weight: 0 }],
          basePrices: { CRM: 250 },
          minConstituents: 1,
        })
    ).toThrow(/weight/);
  });
});

describe("beta estimation", () => {
  it("recovers a known beta from a constructed series", () => {
    const indexReturns = [0.01, -0.02, 0.015, -0.005, 0.03, -0.01];
    const assetReturns = indexReturns.map((r) => r * 1.5);

    const { beta, rSquared } = estimateBeta(assetReturns, indexReturns);
    expect(beta).toBeCloseTo(1.5, 9);
    expect(rSquared).toBeCloseTo(1, 9);
  });

  it("reports low r-squared when the basket does not explain the asset", () => {
    // Two independent noise streams from separate seeds. A beta is still
    // produced -- that is the trap -- but the r-squared says not to lean on it.
    const indexRng = mulberry32(11);
    const assetRng = mulberry32(9_781);
    const indexReturns = Array.from({ length: 250 }, () => (indexRng() - 0.5) * 0.04);
    const assetReturns = Array.from({ length: 250 }, () => (assetRng() - 0.5) * 0.04);

    const { rSquared } = estimateBeta(assetReturns, indexReturns);
    expect(rSquared).toBeLessThan(0.1);
  });

  it("recovers beta from a noisy but genuinely related series", () => {
    const rng = mulberry32(4_242);
    const indexReturns = Array.from({ length: 400 }, () => (rng() - 0.5) * 0.04);
    // True beta 1.3 plus idiosyncratic noise, which is what a real comps
    // regression looks like: high but not perfect explanatory power.
    const assetReturns = indexReturns.map((r) => r * 1.3 + (rng() - 0.5) * 0.01);

    const { beta, rSquared } = estimateBeta(assetReturns, indexReturns);
    expect(beta).toBeCloseTo(1.3, 1);
    expect(rSquared).toBeGreaterThan(0.7);
  });

  it("computes log returns and rejects non-positive prices", () => {
    const returns = logReturns([100, 110, 99]);
    expect(returns).toHaveLength(2);
    expect(returns[0]).toBeCloseTo(Math.log(1.1), 12);
    expect(() => logReturns([100, 0])).toThrow();
  });

  it("rejects mismatched or degenerate inputs", () => {
    expect(() => estimateBeta([0.1, 0.2], [0.1])).toThrow(/equal length/);
    expect(() => estimateBeta([0.1], [0.1])).toThrow(/at least 2/);
    expect(() => estimateBeta([0.1, 0.2], [0.05, 0.05])).toThrow(/zero variance/);
  });
});

describe("compsAdjustmentFactor", () => {
  it("is neutral when the index has not moved", () => {
    expect(compsAdjustmentFactor(1, 1, 12_000, 5_000)).toBeCloseTo(1, 12);
  });

  it("scales the index move by beta, linearly", () => {
    // +25% index, beta 1.2 -> +30%
    expect(compsAdjustmentFactor(1.25, 1, 12_000, 5_000)).toBeCloseTo(1.3, 12);
    // -30% index, beta 1.2 -> -36%
    expect(compsAdjustmentFactor(0.7, 1, 12_000, 5_000)).toBeCloseTo(0.64, 12);
  });

  it("clamps symmetrically at the configured cap", () => {
    expect(compsAdjustmentFactor(2, 1, 12_000, 5_000)).toBeCloseTo(1.5, 12);
    expect(compsAdjustmentFactor(0.4, 1, 12_000, 5_000)).toBeCloseTo(0.5, 12);
  });

  it("is inert at beta zero", () => {
    expect(compsAdjustmentFactor(2, 1, 0, 5_000)).toBeCloseTo(1, 12);
  });

  it("falls back to neutral on a missing or non-positive index level", () => {
    expect(compsAdjustmentFactor(1.25, 0, 12_000, 5_000)).toBe(1);
    expect(compsAdjustmentFactor(0, 1, 12_000, 5_000)).toBe(1);
  });
});

describe("AnchorBook with comparables tracking", () => {
  function bookWithAnchor() {
    const book = new AnchorBook({
      maxBandBps: 5_000,
      maxConfidenceBps: 3_000,
      betaBps: 12_000,
      maxCompAdjustmentBps: 5_000,
    });
    book.record({
      kind: AnchorKind.PRICED_ROUND,
      pricePerShare: 20,
      shareClass: "COMMON",
      effectiveAt: T0,
      bandBps: 1_500,
      compIndexAtEffective: 1,
    });
    return book;
  }

  it("leaves the reference unadjusted when no current index is supplied", () => {
    const ref = bookWithAnchor().getReference(T0)!;
    expect(ref.price).toBeCloseTo(20, 12);
    expect(ref.compAdjustment).toBe(1);
  });

  it("carries the anchor forward with comps while preserving the raw anchor", () => {
    const ref = bookWithAnchor().getReference(T0, 1.25)!;
    expect(ref.anchorPrice).toBe(20);
    expect(ref.compAdjustment).toBeCloseTo(1.3, 12);
    expect(ref.price).toBeCloseTo(26, 12);
  });

  it("moves the whole band with comps, not just the center", () => {
    const band = bookWithAnchor().getBand(T0, 1.25)!;
    expect(band.lower).toBeCloseTo(26 * 0.85, 9);
    expect(band.upper).toBeCloseTo(26 * 1.15, 9);
  });

  it("combines comps recentering with age-based widening", () => {
    const book = bookWithAnchor();
    const fresh = book.getReference(T0, 1.25)!;
    const aged = book.getReference(T0 + 200 * DAY, 1.25)!;

    // Same center -- comps moved identically -- but a wider band.
    expect(aged.price).toBeCloseTo(fresh.price, 9);
    expect(aged.bandBps).toBeGreaterThan(fresh.bandBps);
  });

  it("ignores comps for an anchor that recorded no index level", () => {
    const book = new AnchorBook({
      maxBandBps: 5_000,
      maxConfidenceBps: 3_000,
      betaBps: 12_000,
      maxCompAdjustmentBps: 5_000,
    });
    book.record({
      kind: AnchorKind.PRICED_ROUND,
      pricePerShare: 20,
      shareClass: "COMMON",
      effectiveAt: T0,
      bandBps: 1_500,
    });

    const ref = book.getReference(T0, 1.25)!;
    expect(ref.compAdjustment).toBe(1);
    expect(ref.price).toBe(20);
  });
});
