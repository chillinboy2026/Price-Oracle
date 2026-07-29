import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BinanceAdapter,
  BitstampAdapter,
  CoinbaseAdapter,
  GeminiAdapter,
  KrakenAdapter,
} from "../src/feeds/exchanges/adapters.js";
import { ExchangeAdapter } from "../src/feeds/exchanges/types.js";
import { HttpConfig } from "../src/util/http.js";
import { MockExchangeServer, VenueName } from "./helpers/mockExchangeServer.js";

const HTTP: HttpConfig = { timeoutMs: 2_000, retries: 2, retryBaseDelayMs: 10 };

describe("exchange adapters", () => {
  const server = new MockExchangeServer();
  let baseUrl: string;
  let adapters: Record<VenueName, ExchangeAdapter>;

  beforeAll(async () => {
    baseUrl = await server.listen();
    adapters = {
      coinbase: new CoinbaseAdapter(baseUrl),
      kraken: new KrakenAdapter(baseUrl),
      binance: new BinanceAdapter(baseUrl),
      gemini: new GeminiAdapter(baseUrl),
      bitstamp: new BitstampAdapter(baseUrl),
    };
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => server.reset());

  const venueNames: VenueName[] = ["coinbase", "kraken", "binance", "gemini", "bitstamp"];

  for (const name of venueNames) {
    it(`parses ${name}'s real response shape into a bid/ask midpoint`, async () => {
      const venue = server.venues[name];
      const quote = await adapters[name].fetchQuote("BTC-USD", HTTP);

      expect(quote.source).toBe(name);
      expect(quote.bid).toBeCloseTo(venue.bid, 8);
      expect(quote.ask).toBeCloseTo(venue.ask, 8);
      expect(quote.price).toBeCloseTo((venue.bid + venue.ask) / 2, 8);
      expect(quote.spreadBps).toBeGreaterThan(0);
      expect(quote.timestamp).toBeGreaterThan(0);
    });
  }

  it("reads Kraken's result entry even though its key differs from the requested pair", async () => {
    // The mock returns the sole entry under "XXBTZUSD" while we request "XBTUSD",
    // exactly as the live API does.
    const quote = await adapters.kraken.fetchQuote("BTC-USD", HTTP);
    expect(quote.price).toBeCloseTo((server.venues.kraken.bid + server.venues.kraken.ask) / 2, 8);
  });

  it("throws on a Kraken error payload returned with HTTP 200", async () => {
    server.venues.kraken.rawBody = JSON.stringify({ error: ["EQuery:Unknown asset pair"], result: {} });
    await expect(adapters.kraken.fetchQuote("BTC-USD", HTTP)).rejects.toThrow(/EQuery:Unknown asset pair/);
  });

  it("rejects an unmapped symbol rather than guessing a ticker", async () => {
    await expect(adapters.coinbase.fetchQuote("TSLA-USD", HTTP)).rejects.toThrow(/no ticker mapping/);
  });

  it("rejects a zero or empty price rather than coercing it to 0", async () => {
    server.venues.gemini.rawBody = JSON.stringify({ bid: "0", ask: "100.01", last: "100" });
    await expect(adapters.gemini.fetchQuote("BTC-USD", HTTP)).rejects.toThrow(/malformed/);

    server.venues.bitstamp.rawBody = JSON.stringify({ bid: "", ask: "100.01", last: "100" });
    await expect(adapters.bitstamp.fetchQuote("BTC-USD", HTTP)).rejects.toThrow(/malformed/);
  });

  it("rejects a crossed book", async () => {
    server.venues.coinbase.rawBody = JSON.stringify({ bid: "101", ask: "99", price: "100" });
    await expect(adapters.coinbase.fetchQuote("BTC-USD", HTTP)).rejects.toThrow(/crossed book/);
  });

  it("retries a 5xx and succeeds once the venue recovers", async () => {
    server.venues.binance.failFirstN = 2;
    const quote = await adapters.binance.fetchQuote("BTC-USD", HTTP);
    expect(quote.price).toBeCloseTo((server.venues.binance.bid + server.venues.binance.ask) / 2, 8);
    expect(server.venues.binance.hits).toBe(3); // two failures, then success
  });

  it("does not retry a non-retriable 4xx", async () => {
    server.venues.gemini.status = 400;
    await expect(adapters.gemini.fetchQuote("BTC-USD", HTTP)).rejects.toThrow(/400/);
    expect(server.venues.gemini.hits).toBe(1);
  });

  it("gives up after exhausting retries on a persistent 5xx", async () => {
    server.venues.bitstamp.status = 503;
    await expect(adapters.bitstamp.fetchQuote("BTC-USD", HTTP)).rejects.toThrow(/503/);
    expect(server.venues.bitstamp.hits).toBe(HTTP.retries + 1);
  });
});
