import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

/**
 * A local HTTP server that speaks each venue's *real* response shape, so the
 * adapters are exercised against payloads structurally identical to what the
 * live endpoints return. Only the network hop differs.
 *
 * Payload shapes are taken from each exchange's public API documentation:
 *   Coinbase  GET /products/{id}/ticker
 *   Kraken    GET /0/public/Ticker?pair={pair}
 *   Binance   GET /api/v3/ticker/bookTicker?symbol={symbol}
 *   Gemini    GET /v1/pubticker/{symbol}
 *   Bitstamp  GET /api/v2/ticker/{symbol}/
 */

export interface VenueState {
  bid: number;
  ask: number;
  last: number;
  /** When set, the venue responds with this status instead of a quote. */
  status?: number;
  /** When set, the venue returns this raw body regardless of route. */
  rawBody?: string;
  /** Number of requests served; lets tests assert retry behavior. */
  hits: number;
  /** Fail the first N requests with 503, then succeed. */
  failFirstN?: number;
}

export type VenueName = "coinbase" | "kraken" | "binance" | "gemini" | "bitstamp";

/** Baseline venue prices: five tightly-clustered books whose midpoints are
 * 99.90 / 99.95 / 100.00 / 100.05 / 100.10, so the cross-venue median is
 * exactly 100 and every filtering behavior has an unambiguous expected value. */
const DEFAULT_VENUES: () => Record<VenueName, VenueState> = () => ({
  coinbase: { bid: 99.99, ask: 100.01, last: 100, hits: 0 },
  kraken: { bid: 100.04, ask: 100.06, last: 100.05, hits: 0 },
  binance: { bid: 99.94, ask: 99.96, last: 99.95, hits: 0 },
  gemini: { bid: 100.09, ask: 100.11, last: 100.1, hits: 0 },
  bitstamp: { bid: 99.89, ask: 99.91, last: 99.9, hits: 0 },
});

export class MockExchangeServer {
  private server: Server | null = null;
  venues: Record<VenueName, VenueState> = DEFAULT_VENUES();

  async listen(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((err) => (err ? reject(err) : resolve()))
    );
    this.server = null;
  }

  /** Restores prices *and* fault injection, so a test that moves a venue's
   * book cannot leak that state into the next one. */
  reset(): void {
    this.venues = DEFAULT_VENUES();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "";
    const venueName = this.routeToVenue(url);

    if (!venueName) {
      res.writeHead(404).end("no route");
      return;
    }

    const venue = this.venues[venueName];
    venue.hits += 1;

    if (venue.failFirstN !== undefined && venue.hits <= venue.failFirstN) {
      res.writeHead(503).end("temporarily unavailable");
      return;
    }
    if (venue.status !== undefined) {
      res.writeHead(venue.status).end("error");
      return;
    }
    if (venue.rawBody !== undefined) {
      res.writeHead(200, { "content-type": "application/json" }).end(venue.rawBody);
      return;
    }

    res.writeHead(200, { "content-type": "application/json" }).end(this.body(venueName, venue));
  }

  private routeToVenue(url: string): VenueName | null {
    if (url.startsWith("/products/")) return "coinbase";
    if (url.startsWith("/0/public/Ticker")) return "kraken";
    if (url.startsWith("/api/v3/ticker/bookTicker")) return "binance";
    if (url.startsWith("/v1/pubticker/")) return "gemini";
    if (url.startsWith("/api/v2/ticker/")) return "bitstamp";
    return null;
  }

  private body(name: VenueName, v: VenueState): string {
    switch (name) {
      case "coinbase":
        return JSON.stringify({
          trade_id: 1,
          price: String(v.last),
          size: "0.01",
          bid: String(v.bid),
          ask: String(v.ask),
          volume: "1234.5",
          time: new Date().toISOString(),
        });
      case "kraken":
        // Note the result key differs from the requested pair, as Kraken does.
        return JSON.stringify({
          error: [],
          result: {
            XXBTZUSD: {
              a: [String(v.ask), "1", "1.000"],
              b: [String(v.bid), "2", "2.000"],
              c: [String(v.last), "0.001"],
              v: ["100", "200"],
            },
          },
        });
      case "binance":
        return JSON.stringify({
          symbol: "BTCUSDT",
          bidPrice: String(v.bid),
          bidQty: "1.0",
          askPrice: String(v.ask),
          askQty: "1.0",
        });
      case "gemini":
        return JSON.stringify({
          bid: String(v.bid),
          ask: String(v.ask),
          last: String(v.last),
          volume: { BTC: "100", USD: "6400000", timestamp: Date.now() },
        });
      case "bitstamp":
        return JSON.stringify({
          timestamp: String(Math.floor(Date.now() / 1000)),
          bid: String(v.bid),
          ask: String(v.ask),
          last: String(v.last),
          high: "105",
          low: "95",
          volume: "100",
          vwap: "100",
        });
    }
  }
}
