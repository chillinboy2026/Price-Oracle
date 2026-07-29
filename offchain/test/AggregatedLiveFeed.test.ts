import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AggregatedLiveFeed, FeedEvent } from "../src/feeds/AggregatedLiveFeed.js";
import {
  BinanceAdapter,
  BitstampAdapter,
  CoinbaseAdapter,
  GeminiAdapter,
  KrakenAdapter,
} from "../src/feeds/exchanges/adapters.js";
import { HttpConfig } from "../src/util/http.js";
import { MockExchangeServer } from "./helpers/mockExchangeServer.js";

const HTTP: HttpConfig = { timeoutMs: 2_000, retries: 0, retryBaseDelayMs: 10 };

describe("AggregatedLiveFeed", () => {
  const server = new MockExchangeServer();
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await server.listen();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => server.reset());

  function buildFeed(
    overrides: Partial<ConstructorParameters<typeof AggregatedLiveFeed>[0]> = {},
    events: FeedEvent[] = []
  ) {
    return new AggregatedLiveFeed({
      symbol: "BTC-USD",
      adapters: [
        new CoinbaseAdapter(baseUrl),
        new KrakenAdapter(baseUrl),
        new BinanceAdapter(baseUrl),
        new GeminiAdapter(baseUrl),
        new BitstampAdapter(baseUrl),
      ],
      minSources: 3,
      pollIntervalMs: 60_000,
      maxQuoteAgeMs: 30_000,
      maxSpreadBps: 100,
      maxDeviationBps: 200,
      http: HTTP,
      onEvent: (e) => events.push(e),
      ...overrides,
    });
  }

  it("aggregates all five venues to the cross-venue median", async () => {
    const feed = buildFeed();
    const snapshot = await feed.poll();

    expect(snapshot).not.toBeNull();
    expect(snapshot!.sources).toHaveLength(5);
    // Venue mids: 99.90, 99.95, 100.00, 100.05, 100.10 -> median 100.00
    expect(snapshot!.price).toBeCloseTo(100.0, 6);

    const quote = feed.quote(new Date());
    expect(quote).not.toBeNull();
    expect(quote!.price).toBeCloseTo(100.0, 6);
  });

  it("discards a venue that deviates wildly and prices off the rest", async () => {
    const events: FeedEvent[] = [];
    const feed = buildFeed({}, events);

    // Binance prints 3x the others -- a compromised or broken venue.
    server.venues.binance.bid = 299.9;
    server.venues.binance.ask = 300.1;

    const snapshot = await feed.poll();

    expect(snapshot!.sources).not.toContain("binance");
    expect(snapshot!.sources).toHaveLength(4);
    // Surviving mids: 99.90, 100.00, 100.05, 100.10 -> median 100.025
    expect(snapshot!.price).toBeCloseTo(100.025, 6);

    expect(events).toContainEqual(
      expect.objectContaining({ kind: "source_rejected", source: "binance" })
    );
  });

  it("bounds a single manipulated venue's influence to the honest venues' own dispersion", async () => {
    const clean = (await buildFeed().poll())!;

    server.venues.gemini.bid = 5_000;
    server.venues.gemini.ask = 5_000.2;
    const attacked = (await buildFeed().poll())!;

    // The attacker printed ~50x the true price. Dropping their venue does shift
    // the median slightly -- removing a sample from an odd-sized set leaves an
    // even one -- but the shift is bounded by the gap between adjacent *honest*
    // venues, not by how extreme the lie was.
    const impactBps = (Math.abs(attacked.price - clean.price) / clean.price) * 10_000;
    expect(impactBps).toBeLessThan(5);
    expect(attacked.price).toBeGreaterThanOrEqual(99.9);
    expect(attacked.price).toBeLessThanOrEqual(100.1);
    expect(attacked.sources).not.toContain("gemini");
  });

  it("gives a manipulator no extra leverage from a more extreme lie", async () => {
    server.venues.gemini.bid = 500;
    server.venues.gemini.ask = 500.2;
    const modest = (await buildFeed().poll())!;

    server.venues.gemini.bid = 5_000_000;
    server.venues.gemini.ask = 5_000_000.2;
    const extreme = (await buildFeed().poll())!;

    // This is the property that actually matters: once a venue is outside the
    // outlier band its print is discarded outright, so lying harder buys the
    // attacker exactly nothing.
    expect(extreme.price).toBeCloseTo(modest.price, 6);
  });

  it("drops a venue whose book has blown out, even if its mid looks reasonable", async () => {
    const events: FeedEvent[] = [];
    const feed = buildFeed({}, events);

    // Mid stays at 100 but the book is 10% wide -- thin/broken liquidity.
    server.venues.coinbase.bid = 95;
    server.venues.coinbase.ask = 105;

    const snapshot = await feed.poll();

    expect(snapshot!.sources).not.toContain("coinbase");
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "source_rejected", source: "coinbase", reason: expect.stringContaining("spread") })
    );
  });

  it("routes around venues that are down entirely", async () => {
    const events: FeedEvent[] = [];
    const feed = buildFeed({}, events);

    server.venues.coinbase.status = 503;
    server.venues.kraken.status = 500;

    const snapshot = await feed.poll();

    expect(snapshot!.sources).toEqual(expect.arrayContaining(["binance", "gemini", "bitstamp"]));
    expect(snapshot!.sources).toHaveLength(3);
    expect(events).toContainEqual(expect.objectContaining({ kind: "source_failed", source: "coinbase" }));

    const health = feed.getHealth();
    expect(health.find((h) => h.source === "coinbase")!.consecutiveFailures).toBe(1);
    expect(health.find((h) => h.source === "binance")!.consecutiveFailures).toBe(0);
  });

  it("publishes no new price when too few venues survive the quorum", async () => {
    const events: FeedEvent[] = [];
    const feed = buildFeed({}, events);

    server.venues.coinbase.status = 503;
    server.venues.kraken.status = 503;
    server.venues.binance.status = 503;

    const snapshot = await feed.poll();

    expect(snapshot).toBeNull();
    expect(feed.quote(new Date())).toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "quorum_failed", healthy: 2, required: 3 })
    );
  });

  it("keeps serving the last good price through a single failed round, then lets it expire", async () => {
    const feed = buildFeed({ maxQuoteAgeMs: 30_000 });
    const good = await feed.poll();
    expect(good).not.toBeNull();

    // Every venue goes down: the round fails but the cache survives it.
    for (const venue of Object.values(server.venues)) venue.status = 503;
    await feed.poll();

    const stillFresh = feed.quote(new Date());
    expect(stillFresh).not.toBeNull();
    expect(stillFresh!.price).toBeCloseTo(good!.price, 6);

    // Past the staleness horizon the feed reports nothing, which downstream is
    // treated exactly like a closed market.
    const later = new Date(Date.now() + 60_000);
    expect(feed.quote(later)).toBeNull();
  });

  it("reports no quote before the first poll has completed", () => {
    const feed = buildFeed();
    expect(feed.quote(new Date())).toBeNull();
    expect(feed.getSnapshot()).toBeNull();
  });

  it("start() resolves with a warm cache and stop() halts polling", async () => {
    const feed = buildFeed({ pollIntervalMs: 50 });
    await feed.start();

    expect(feed.quote(new Date())).not.toBeNull();

    feed.stop();
    const hitsAfterStop = server.venues.coinbase.hits;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.venues.coinbase.hits).toBe(hitsAfterStop);
  });

  it("skips outlier filtering when too few venues remain to identify one", async () => {
    const feed = buildFeed({
      adapters: [new CoinbaseAdapter(baseUrl), new KrakenAdapter(baseUrl)],
      minSources: 2,
    });

    // With only two venues there is no majority to call either an outlier, so
    // both are kept and the median is their midpoint.
    const snapshot = await feed.poll();
    expect(snapshot!.sources).toHaveLength(2);
    expect(snapshot!.price).toBeCloseTo((100.0 + 100.05) / 2, 6);
  });
});
