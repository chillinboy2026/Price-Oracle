import { describe, expect, it } from "vitest";
import {
  commonToPreferredRatioBps,
  expectedCommonPrice,
  fullyDilutedShares,
  preferenceOverhang,
  preferredPricePerShare,
  waterfall,
} from "../src/anchor/capTable.js";
import { CapTable } from "../src/anchor/types.js";

/** A plausible late-stage cap table: 100m shares fully diluted, $700m raised
 * across three non-participating 1x series. */
function acme(): CapTable {
  return {
    commonShares: 50_000_000,
    preferred: [
      { name: "Series A", shares: 10_000_000, issuePrice: 1, multiple: 1, participating: false, seniority: 1 },
      { name: "Series B", shares: 10_000_000, issuePrice: 5, multiple: 1, participating: false, seniority: 1 },
      { name: "Series C", shares: 10_000_000, issuePrice: 64, multiple: 1, participating: false, seniority: 1 },
    ],
    optionsOutstanding: 12_000_000,
    optionPoolUnissued: 7_000_000,
    warrants: 1_000_000,
  };
}

describe("cap table math", () => {
  it("counts fully diluted shares including the unissued option pool", () => {
    expect(fullyDilutedShares(acme())).toBe(100_000_000);
  });

  it("computes the preference overhang", () => {
    // 10m*$1 + 10m*$5 + 10m*$64 = $700m
    expect(preferenceOverhang(acme())).toBe(700_000_000);
  });

  it("prices the preferred round as post-money over fully diluted shares", () => {
    expect(preferredPricePerShare(1_000_000_000, acme())).toBeCloseTo(10, 9);
  });

  it("converts every series when the valuation clears the whole stack, so common == preferred", () => {
    const capTable = acme();
    // $10bn over 100m fully diluted shares implies $100/share, above even
    // Series C's $64 issue price, so no series does better taking preference.
    const valuation = 10_000_000_000;

    const result = waterfall(valuation, capTable);
    expect(result.convertedSeries).toHaveLength(3);
    expect(result.preferencePaid).toBe(0);
    expect(result.commonPricePerShare).toBeCloseTo(100, 6);
    expect(commonToPreferredRatioBps(valuation, capTable)).toBeCloseTo(10_000, 3);
  });

  it("lets an underwater late series take its preference, dragging common below the headline", () => {
    const capTable = acme();
    // $5bn implies $50/share -- healthy in absolute terms, but *below* the $64
    // Series C paid. C is underwater, so it exercises its downside protection
    // and takes its $640m preference rather than converting. Common is worse
    // off than the headline price suggests even though nothing went wrong.
    const result = waterfall(5_000_000_000, capTable);

    expect(result.convertedSeries).toEqual(["Series A", "Series B"]);
    expect(result.preferencePaid).toBe(640_000_000);
    // ($5bn - $640m) over 90m common-equivalent shares.
    expect(result.commonPricePerShare).toBeCloseTo(4_360_000_000 / 90_000_000, 6);
    expect(result.commonPricePerShare).toBeLessThan(preferredPricePerShare(5_000_000_000, capTable));
  });

  it("subordinates common heavily when the exit is near the preference stack", () => {
    const capTable = acme();
    // At $800m the $700m stack dominates. Series A paid only $1/share, so it
    // still does better converting ($1.375) than taking its preference; B and
    // C do not, and take theirs.
    const result = waterfall(800_000_000, capTable);

    expect(result.convertedSeries).toEqual(["Series A"]);
    expect(result.preferencePaid).toBe(690_000_000);
    // ($800m - $690m) over 80m common-equivalent shares = $1.375.
    expect(result.commonPricePerShare).toBeCloseTo(110_000_000 / 80_000_000, 6);

    // The headline "price per share" here would be $8, so publishing it as
    // common's price would overstate it by nearly 6x.
    const headline = preferredPricePerShare(800_000_000, capTable);
    expect(headline).toBeCloseTo(8, 6);
    expect(result.commonPricePerShare).toBeLessThan(headline / 5);
  });

  it("wipes out common entirely below the preference stack", () => {
    const result = waterfall(500_000_000, acme());
    expect(result.commonPricePerShare).toBe(0);
    expect(result.preferencePaid).toBe(500_000_000);
  });

  it("pays senior series first when the stack cannot be paid in full", () => {
    const capTable: CapTable = {
      commonShares: 10_000_000,
      preferred: [
        { name: "Junior", shares: 1_000_000, issuePrice: 10, multiple: 1, participating: false, seniority: 1 },
        { name: "Senior", shares: 1_000_000, issuePrice: 10, multiple: 1, participating: false, seniority: 2 },
      ],
      optionsOutstanding: 0,
      optionPoolUnissued: 0,
      warrants: 0,
    };

    // $15m available against a $20m stack: Senior's $10m is paid in full,
    // Junior gets the remaining $5m, common gets nothing.
    const result = waterfall(15_000_000, capTable);
    expect(result.preferencePaid).toBe(15_000_000);
    expect(result.commonPricePerShare).toBe(0);
  });

  it("splits a tier pro rata when it cannot be paid in full", () => {
    const capTable: CapTable = {
      commonShares: 10_000_000,
      preferred: [
        { name: "A", shares: 1_000_000, issuePrice: 10, multiple: 1, participating: false, seniority: 1 },
        { name: "B", shares: 1_000_000, issuePrice: 30, multiple: 1, participating: false, seniority: 1 },
      ],
      optionsOutstanding: 0,
      optionPoolUnissued: 0,
      warrants: 0,
    };

    // $20m against a $40m pari passu tier: all of it goes to preference.
    const result = waterfall(20_000_000, capTable);
    expect(result.preferencePaid).toBe(20_000_000);
    expect(result.commonPricePerShare).toBe(0);
  });

  it("depresses common further with participating preferred", () => {
    const base = acme();
    const participating: CapTable = {
      ...base,
      preferred: base.preferred.map((s) => ({ ...s, participating: true })),
    };

    const valuation = 2_000_000_000;
    const plain = waterfall(valuation, base).commonPricePerShare;
    const withParticipation = waterfall(valuation, participating).commonPricePerShare;

    // Participating preferred takes its $700m off the top *and* shares the
    // residual, so common is strictly worse off.
    expect(withParticipation).toBeLessThan(plain);
  });

  it("weights the waterfall across exit scenarios", () => {
    const capTable = acme();
    const scenarios = [
      { exitValue: 5_000_000_000, probability: 0.3 }, // strong exit -> $50
      { exitValue: 1_000_000_000, probability: 0.5 }, // ok exit
      { exitValue: 400_000_000, probability: 0.2 }, // below the stack -> $0
    ];

    const expectedPrice = expectedCommonPrice(scenarios, capTable);

    const manual =
      (waterfall(5_000_000_000, capTable).commonPricePerShare * 0.3 +
        waterfall(1_000_000_000, capTable).commonPricePerShare * 0.5 +
        waterfall(400_000_000, capTable).commonPricePerShare * 0.2) /
      1.0;
    expect(expectedPrice).toBeCloseTo(manual, 6);

    // The downside scenarios drag the expectation well below the best case.
    expect(expectedPrice).toBeLessThan(waterfall(5_000_000_000, capTable).commonPricePerShare);
  });

  it("applies an explicit marketability discount", () => {
    const capTable = acme();
    const scenarios = [{ exitValue: 5_000_000_000, probability: 1 }];

    const undiscounted = expectedCommonPrice(scenarios, capTable, 0);
    const discounted = expectedCommonPrice(scenarios, capTable, 2_500); // 25% DLOM

    expect(discounted).toBeCloseTo(undiscounted * 0.75, 6);
  });

  it("normalizes scenario weights that do not sum to one", () => {
    const capTable = acme();
    const a = expectedCommonPrice([{ exitValue: 2e9, probability: 1 }, { exitValue: 1e9, probability: 1 }], capTable);
    const b = expectedCommonPrice([{ exitValue: 2e9, probability: 5 }, { exitValue: 1e9, probability: 5 }], capTable);
    expect(a).toBeCloseTo(b, 9);
  });

  it("rejects degenerate inputs", () => {
    expect(() => expectedCommonPrice([], acme())).toThrow();
    expect(() => expectedCommonPrice([{ exitValue: 1e9, probability: 0 }], acme())).toThrow();
    expect(() =>
      preferredPricePerShare(1e9, {
        commonShares: 0,
        preferred: [],
        optionsOutstanding: 0,
        optionPoolUnissued: 0,
        warrants: 0,
      })
    ).toThrow();
  });
});
