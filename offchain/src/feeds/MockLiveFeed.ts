import { LiveFeedQuote } from "../types.js";
import { RandomFn } from "../util/rng.js";
import { LiveFeed } from "./types.js";

export interface MockLiveFeedConfig {
  initialPrice: number;
  /** Annualized volatility, e.g. 0.3 = 30%. */
  annualizedVolatility: number;
  /** UTC hour the reference market opens, e.g. 13 (~9:30am ET). */
  sessionStartUtcHour: number;
  /** UTC hour the reference market closes, e.g. 20 (~4:00pm ET). */
  sessionEndUtcHour: number;
  random?: RandomFn;
}

/**
 * Stand-in for a real live market data feed (an equities SIP feed, a
 * pre-IPO comparable, an FX/rates source, etc). Only produces a quote while
 * `now` falls inside the configured trading-hours window on a weekday;
 * otherwise returns null so the engine knows to fall back to its off-hours
 * synthetic model. A real integration swaps this class out for one that
 * calls an actual market data API/websocket and keeps the same `LiveFeed`
 * interface -- nothing else in the engine needs to change.
 */
export class MockLiveFeed implements LiveFeed {
  private price: number;
  private lastTickAt: Date | null = null;
  private readonly random: RandomFn;

  constructor(private readonly config: MockLiveFeedConfig) {
    this.price = config.initialPrice;
    this.random = config.random ?? Math.random;
  }

  isSessionOpen(now: Date): boolean {
    const day = now.getUTCDay();
    if (day === 0 || day === 6) return false;
    const hour = now.getUTCHours();
    return hour >= this.config.sessionStartUtcHour && hour < this.config.sessionEndUtcHour;
  }

  quote(now: Date): LiveFeedQuote | null {
    if (!this.isSessionOpen(now)) {
      this.lastTickAt = null;
      return null;
    }

    const elapsedSeconds = this.lastTickAt ? (now.getTime() - this.lastTickAt.getTime()) / 1000 : 1;
    const elapsedYears = Math.max(elapsedSeconds, 1) / (365 * 24 * 3600);
    const volatility = this.config.annualizedVolatility;
    const shock = (this.random() * 2 - 1) * Math.sqrt(elapsedYears) * volatility;
    this.price = this.price * Math.exp(-0.5 * volatility ** 2 * elapsedYears + shock);
    this.lastTickAt = now;

    return { price: this.price, timestamp: Math.floor(now.getTime() / 1000) };
  }
}
