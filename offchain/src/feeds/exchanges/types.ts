import { FetchLike, HttpConfig } from "../../util/http.js";

/** A single venue's observation, normalized across exchanges. */
export interface ExchangeQuote {
  source: string;
  /** Reference price for aggregation: the bid/ask midpoint where the venue
   * publishes a book, otherwise the last trade. Mid is preferred because a
   * single print can be walked by a small trade, whereas moving the midpoint
   * requires standing in the book on both sides. */
  price: number;
  bid?: number;
  ask?: number;
  /** Book width in bps of mid. A blown-out spread is the clearest signal that
   * a venue's book is thin or broken, so the aggregator uses it to drop the
   * venue rather than trusting its midpoint. */
  spreadBps?: number;
  /** Unix seconds when this process observed the quote. Deliberately our own
   * clock, not the venue's: exchange-reported timestamps vary in format,
   * precision and honesty, and we only need staleness relative to us. */
  timestamp: number;
}

export interface ExchangeAdapter {
  readonly name: string;
  /** Fetches one quote for the canonical `symbol` (e.g. "BTC-USD"), mapping it
   * to whatever ticker string the venue actually uses. Throws if the venue is
   * unreachable, returns an error payload, or does not list the symbol. */
  fetchQuote(symbol: string, http: HttpConfig, fetchImpl?: FetchLike): Promise<ExchangeQuote>;
}

export class UnsupportedSymbolError extends Error {
  constructor(source: string, symbol: string) {
    super(`${source} adapter has no ticker mapping for symbol "${symbol}"`);
    this.name = "UnsupportedSymbolError";
  }
}

export class MalformedResponseError extends Error {
  constructor(source: string, detail: string) {
    super(`${source} returned a malformed response: ${detail}`);
    this.name = "MalformedResponseError";
  }
}

/** Parses an exchange's stringly-typed numeric field, rejecting anything that
 * is not a usable positive price. Exchanges do return "0", null and "" for
 * halted or delisted markets, and silently coercing those to 0 would poison
 * the median. */
export function parsePositiveNumber(source: string, field: string, raw: unknown): number {
  const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new MalformedResponseError(source, `${field} was ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Builds a normalized quote from an optional book plus an optional last
 * trade, preferring the midpoint. */
export function buildQuote(
  source: string,
  parts: { bid?: number; ask?: number; last?: number },
  now: number
): ExchangeQuote {
  const { bid, ask, last } = parts;

  if (bid !== undefined && ask !== undefined) {
    // A crossed book (bid above ask) means we are reading the venue wrong or
    // it is publishing garbage; either way it is not safe to price from.
    if (bid > ask) {
      throw new MalformedResponseError(source, `crossed book: bid ${bid} > ask ${ask}`);
    }
    const mid = (bid + ask) / 2;
    return { source, price: mid, bid, ask, spreadBps: ((ask - bid) / mid) * 10_000, timestamp: now };
  }

  if (last !== undefined) {
    return { source, price: last, timestamp: now };
  }

  throw new MalformedResponseError(source, "response contained neither a book nor a last trade");
}
