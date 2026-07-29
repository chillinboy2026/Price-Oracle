import { describe, expect, it } from "vitest";
import { median } from "../src/aggregation/median.js";

describe("median", () => {
  it("returns the middle value for an odd-length list", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for an even-length list", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("is resistant to a single outlier", () => {
    expect(median([100, 101, 99, 10_000])).toBe(100.5);
  });

  it("throws on an empty list", () => {
    expect(() => median([])).toThrow();
  });
});
