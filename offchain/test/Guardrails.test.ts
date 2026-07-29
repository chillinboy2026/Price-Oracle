import { describe, expect, it } from "vitest";
import { clampToDeviation, deviationBps, maxDeviationForSession } from "../src/engine/Guardrails.js";
import { MarketSession } from "../src/types.js";

describe("Guardrails", () => {
  it("computes deviation in bps", () => {
    expect(deviationBps(100, 102)).toBeCloseTo(200, 6);
    expect(deviationBps(100, 100)).toBe(0);
    expect(deviationBps(0, 50)).toBe(0);
  });

  it("picks the tighter off-hours bound", () => {
    const config = { maxDeviationBpsLive: 200, maxDeviationBpsOffHours: 50 };
    expect(maxDeviationForSession(MarketSession.LIVE, config)).toBe(200);
    expect(maxDeviationForSession(MarketSession.OFF_HOURS, config)).toBe(50);
  });

  it("passes proposals within the guardrail through unchanged", () => {
    expect(clampToDeviation(100, 101, 200)).toBeCloseTo(101, 6);
  });

  it("clamps proposals that exceed the guardrail on the upside", () => {
    expect(clampToDeviation(100, 110, 200)).toBeCloseTo(102, 6);
  });

  it("clamps proposals that exceed the guardrail on the downside", () => {
    expect(clampToDeviation(100, 90, 200)).toBeCloseTo(98, 6);
  });

  it("passes through when there is no previous price to anchor to", () => {
    expect(clampToDeviation(0, 150, 200)).toBe(150);
  });
});
