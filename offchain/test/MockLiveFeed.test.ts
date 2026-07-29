import { describe, expect, it } from "vitest";
import { MockLiveFeed } from "../src/feeds/MockLiveFeed.js";

describe("MockLiveFeed", () => {
  it("returns null outside the configured trading-hours window", () => {
    const feed = new MockLiveFeed({
      initialPrice: 100,
      annualizedVolatility: 0.3,
      sessionStartUtcHour: 13,
      sessionEndUtcHour: 20,
    });

    const beforeOpen = new Date(Date.UTC(2026, 0, 6, 10, 0, 0)); // Tuesday 10:00 UTC
    expect(feed.quote(beforeOpen)).toBeNull();

    const afterClose = new Date(Date.UTC(2026, 0, 6, 21, 0, 0));
    expect(feed.quote(afterClose)).toBeNull();
  });

  it("returns null on weekends", () => {
    const feed = new MockLiveFeed({
      initialPrice: 100,
      annualizedVolatility: 0.3,
      sessionStartUtcHour: 13,
      sessionEndUtcHour: 20,
    });
    const saturday = new Date(Date.UTC(2026, 0, 10, 15, 0, 0));
    expect(feed.quote(saturday)).toBeNull();
  });

  it("returns a quote during the trading-hours window on a weekday", () => {
    const feed = new MockLiveFeed({
      initialPrice: 100,
      annualizedVolatility: 0.3,
      sessionStartUtcHour: 13,
      sessionEndUtcHour: 20,
      random: () => 0.5, // no shock -> deterministic near-initial price
    });
    const duringSession = new Date(Date.UTC(2026, 0, 6, 15, 0, 0));
    const result = feed.quote(duringSession);
    expect(result).not.toBeNull();
    expect(result!.price).toBeGreaterThan(0);
  });

  it("does not advance the price across a closed period", () => {
    const feed = new MockLiveFeed({
      initialPrice: 100,
      annualizedVolatility: 0.3,
      sessionStartUtcHour: 13,
      sessionEndUtcHour: 20,
      random: () => 0.5,
    });
    const firstTick = feed.quote(new Date(Date.UTC(2026, 0, 6, 19, 59, 0)));
    const closed = feed.quote(new Date(Date.UTC(2026, 0, 6, 22, 0, 0)));
    const nextDayOpen = feed.quote(new Date(Date.UTC(2026, 0, 7, 13, 0, 0)));

    expect(firstTick).not.toBeNull();
    expect(closed).toBeNull();
    expect(nextDayOpen).not.toBeNull();
  });
});
