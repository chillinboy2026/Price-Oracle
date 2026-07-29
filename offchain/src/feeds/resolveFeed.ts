import { AggregatedLiveFeed } from "./AggregatedLiveFeed.js";
import { defaultAdapters } from "./exchanges/adapters.js";
import { MockLiveFeed } from "./MockLiveFeed.js";
import { LiveFeed } from "./types.js";

export type FeedMode = "crypto" | "mock";

export interface ResolvedFeed {
  feed: LiveFeed;
  mode: FeedMode;
  /** Seed price for the reporters' engines. For a live feed this is the first
   * real aggregate, so the network starts anchored to the market rather than
   * having to converge to it from an arbitrary guess. */
  initialPrice: number;
  describe: string;
  stop(): void;
}

export interface ResolveFeedOptions {
  mode: FeedMode;
  /** Canonical symbol for the crypto feed, e.g. "BTC-USD". */
  symbol: string;
  /** Fallback seed price, used by the mock feed and if the live feed cannot
   * reach quorum on its first poll. */
  initialPrice: number;
  minSources: number;
  pollIntervalMs: number;
  verbose: boolean;
}

/**
 * Builds the live feed the reporter network will price against.
 *
 * `crypto` mode polls real public exchange endpoints; `mock` mode runs the
 * simulated equity-hours random walk. Both satisfy the same `LiveFeed`
 * interface, so nothing downstream of this function knows or cares which is in
 * use -- including the "no quote right now" path, which a closed equity market
 * and a crypto venue outage both take.
 */
export async function resolveFeed(options: ResolveFeedOptions): Promise<ResolvedFeed> {
  if (options.mode === "mock") {
    return {
      feed: new MockLiveFeed({
        initialPrice: options.initialPrice,
        annualizedVolatility: 0.3,
        sessionStartUtcHour: 13,
        sessionEndUtcHour: 20,
      }),
      mode: "mock",
      initialPrice: options.initialPrice,
      describe: "simulated equity feed (13:00-20:00 UTC weekdays)",
      stop: () => {},
    };
  }

  const adapters = defaultAdapters();
  const feed = new AggregatedLiveFeed({
    symbol: options.symbol,
    adapters,
    minSources: options.minSources,
    pollIntervalMs: options.pollIntervalMs,
    // Tolerate roughly three missed polls before the cached price is retired.
    maxQuoteAgeMs: options.pollIntervalMs * 3,
    maxSpreadBps: 100,
    maxDeviationBps: 200,
    onEvent: (event) => {
      if (event.kind === "aggregated") {
        if (options.verbose) {
          console.log(`  [feed] ${event.price.toFixed(2)} from ${event.sources.join(", ")}`);
        }
        return;
      }
      // Failures and rejections are always worth surfacing: they are how an
      // operator notices a venue going bad before quorum is actually lost.
      console.warn(`  [feed] ${JSON.stringify(event)}`);
    },
  });

  await feed.start();

  const snapshot = feed.getSnapshot();
  if (!snapshot) {
    console.warn(
      `Live feed could not reach a ${options.minSources}-venue quorum for ${options.symbol} on startup; ` +
        `seeding from INITIAL_PRICE=${options.initialPrice} and continuing. The engine will run on its ` +
        `off-hours model until enough venues respond.`
    );
  }

  return {
    feed,
    mode: "crypto",
    initialPrice: snapshot?.price ?? options.initialPrice,
    describe: `${adapters.length} public exchanges (${adapters.map((a) => a.name).join(", ")}), ` +
      `quorum ${options.minSources}, polling every ${options.pollIntervalMs}ms`,
    stop: () => feed.stop(),
  };
}
