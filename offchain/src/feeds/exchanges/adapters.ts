import { FetchLike, HttpConfig, fetchJson } from "../../util/http.js";
import {
  ExchangeAdapter,
  ExchangeQuote,
  MalformedResponseError,
  UnsupportedSymbolError,
  buildQuote,
  parsePositiveNumber,
} from "./types.js";

/**
 * Adapters for public, keyless spot endpoints on major crypto venues.
 *
 * Every adapter takes a `baseUrl` so the same code can be pointed at a local
 * server in tests; the defaults are the real production hosts.
 *
 * A note on venue selection: these are all USD or USD-stablecoin spot markets
 * for the same asset, which is what makes a cross-venue median meaningful --
 * they should agree to within a few bps, and a venue that does not is either
 * broken or being manipulated. See BinanceAdapter for the one caveat.
 */

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Canonical symbol -> venue ticker. Unmapped symbols throw rather than being
 * guessed at, since a wrong ticker would silently price the wrong asset. */
type SymbolMap = Record<string, string>;

function mapSymbol(source: string, map: SymbolMap, symbol: string): string {
  const mapped = map[symbol];
  if (!mapped) throw new UnsupportedSymbolError(source, symbol);
  return mapped;
}

// ---------------------------------------------------------------------------
// Coinbase Exchange
// GET /products/{id}/ticker
// -> {"bid":"63999.99","ask":"64000.01","price":"64000.00","volume":"...", ...}
// ---------------------------------------------------------------------------

export class CoinbaseAdapter implements ExchangeAdapter {
  readonly name = "coinbase";
  private static readonly SYMBOLS: SymbolMap = {
    "BTC-USD": "BTC-USD",
    "ETH-USD": "ETH-USD",
    "SOL-USD": "SOL-USD",
  };

  constructor(private readonly baseUrl = "https://api.exchange.coinbase.com") {}

  async fetchQuote(symbol: string, http: HttpConfig, fetchImpl?: FetchLike): Promise<ExchangeQuote> {
    const ticker = mapSymbol(this.name, CoinbaseAdapter.SYMBOLS, symbol);
    const body = await fetchJson<{ bid?: string; ask?: string; price?: string }>(
      `${this.baseUrl}/products/${ticker}/ticker`,
      http,
      fetchImpl
    );

    return buildQuote(
      this.name,
      {
        bid: parsePositiveNumber(this.name, "bid", body.bid),
        ask: parsePositiveNumber(this.name, "ask", body.ask),
        last: body.price === undefined ? undefined : parsePositiveNumber(this.name, "price", body.price),
      },
      nowSeconds()
    );
  }
}

// ---------------------------------------------------------------------------
// Kraken
// GET /0/public/Ticker?pair={pair}
// -> {"error":[],"result":{"XXBTZUSD":{"a":[ask,..],"b":[bid,..],"c":[last,..]}}}
// ---------------------------------------------------------------------------

interface KrakenTickerEntry {
  a?: string[];
  b?: string[];
  c?: string[];
}

export class KrakenAdapter implements ExchangeAdapter {
  readonly name = "kraken";
  private static readonly SYMBOLS: SymbolMap = {
    "BTC-USD": "XBTUSD",
    "ETH-USD": "ETHUSD",
    "SOL-USD": "SOLUSD",
  };

  constructor(private readonly baseUrl = "https://api.kraken.com") {}

  async fetchQuote(symbol: string, http: HttpConfig, fetchImpl?: FetchLike): Promise<ExchangeQuote> {
    const pair = mapSymbol(this.name, KrakenAdapter.SYMBOLS, symbol);
    const body = await fetchJson<{ error?: string[]; result?: Record<string, KrakenTickerEntry> }>(
      `${this.baseUrl}/0/public/Ticker?pair=${pair}`,
      http,
      fetchImpl
    );

    // Kraken signals failure in a 200 body rather than an HTTP status.
    if (body.error && body.error.length > 0) {
      throw new MalformedResponseError(this.name, `API error ${body.error.join(", ")}`);
    }

    // Kraken keys the result by its own internal pair name (XBTUSD -> XXBTZUSD),
    // which does not match the requested pair, so read the sole entry instead
    // of looking up by the name we asked for.
    const entries = Object.values(body.result ?? {});
    if (entries.length !== 1) {
      throw new MalformedResponseError(this.name, `expected exactly 1 result entry, got ${entries.length}`);
    }
    const entry = entries[0];

    return buildQuote(
      this.name,
      {
        bid: parsePositiveNumber(this.name, "b[0]", entry.b?.[0]),
        ask: parsePositiveNumber(this.name, "a[0]", entry.a?.[0]),
        last: entry.c?.[0] === undefined ? undefined : parsePositiveNumber(this.name, "c[0]", entry.c[0]),
      },
      nowSeconds()
    );
  }
}

// ---------------------------------------------------------------------------
// Binance
// GET /api/v3/ticker/bookTicker?symbol={symbol}
// -> {"symbol":"BTCUSDT","bidPrice":"...","askPrice":"...", ...}
// ---------------------------------------------------------------------------

export class BinanceAdapter implements ExchangeAdapter {
  readonly name = "binance";
  /** Binance's deep USD books are quoted in USDT, not USD. That introduces a
   * small stablecoin basis (USDT has historically depegged by tens of bps and
   * occasionally far more under stress), so this venue is not measuring quite
   * the same thing as the USD venues above. It is included because its depth
   * makes it hard to manipulate, but for an oracle that settles in USD the
   * honest options are to price the USDT/USD leg explicitly or to weight this
   * venue down. The aggregator's outlier rejection will drop it automatically
   * during a serious depeg, which covers the tail but not the steady-state
   * basis. */
  private static readonly SYMBOLS: SymbolMap = {
    "BTC-USD": "BTCUSDT",
    "ETH-USD": "ETHUSDT",
    "SOL-USD": "SOLUSDT",
  };

  constructor(private readonly baseUrl = "https://api.binance.com") {}

  async fetchQuote(symbol: string, http: HttpConfig, fetchImpl?: FetchLike): Promise<ExchangeQuote> {
    const ticker = mapSymbol(this.name, BinanceAdapter.SYMBOLS, symbol);
    const body = await fetchJson<{ bidPrice?: string; askPrice?: string }>(
      `${this.baseUrl}/api/v3/ticker/bookTicker?symbol=${ticker}`,
      http,
      fetchImpl
    );

    return buildQuote(
      this.name,
      {
        bid: parsePositiveNumber(this.name, "bidPrice", body.bidPrice),
        ask: parsePositiveNumber(this.name, "askPrice", body.askPrice),
      },
      nowSeconds()
    );
  }
}

// ---------------------------------------------------------------------------
// Gemini
// GET /v1/pubticker/{symbol}
// -> {"bid":"...","ask":"...","last":"...","volume":{...}}
// ---------------------------------------------------------------------------

export class GeminiAdapter implements ExchangeAdapter {
  readonly name = "gemini";
  private static readonly SYMBOLS: SymbolMap = {
    "BTC-USD": "btcusd",
    "ETH-USD": "ethusd",
    "SOL-USD": "solusd",
  };

  constructor(private readonly baseUrl = "https://api.gemini.com") {}

  async fetchQuote(symbol: string, http: HttpConfig, fetchImpl?: FetchLike): Promise<ExchangeQuote> {
    const ticker = mapSymbol(this.name, GeminiAdapter.SYMBOLS, symbol);
    const body = await fetchJson<{ bid?: string; ask?: string; last?: string }>(
      `${this.baseUrl}/v1/pubticker/${ticker}`,
      http,
      fetchImpl
    );

    return buildQuote(
      this.name,
      {
        bid: parsePositiveNumber(this.name, "bid", body.bid),
        ask: parsePositiveNumber(this.name, "ask", body.ask),
        last: body.last === undefined ? undefined : parsePositiveNumber(this.name, "last", body.last),
      },
      nowSeconds()
    );
  }
}

// ---------------------------------------------------------------------------
// Bitstamp
// GET /api/v2/ticker/{symbol}/
// -> {"bid":"...","ask":"...","last":"...","timestamp":"...", ...}
// ---------------------------------------------------------------------------

export class BitstampAdapter implements ExchangeAdapter {
  readonly name = "bitstamp";
  private static readonly SYMBOLS: SymbolMap = {
    "BTC-USD": "btcusd",
    "ETH-USD": "ethusd",
    "SOL-USD": "solusd",
  };

  constructor(private readonly baseUrl = "https://www.bitstamp.net") {}

  async fetchQuote(symbol: string, http: HttpConfig, fetchImpl?: FetchLike): Promise<ExchangeQuote> {
    const ticker = mapSymbol(this.name, BitstampAdapter.SYMBOLS, symbol);
    const body = await fetchJson<{ bid?: string; ask?: string; last?: string }>(
      `${this.baseUrl}/api/v2/ticker/${ticker}/`,
      http,
      fetchImpl
    );

    return buildQuote(
      this.name,
      {
        bid: parsePositiveNumber(this.name, "bid", body.bid),
        ask: parsePositiveNumber(this.name, "ask", body.ask),
        last: body.last === undefined ? undefined : parsePositiveNumber(this.name, "last", body.last),
      },
      nowSeconds()
    );
  }
}

/** The default venue set: three USD-quoted books plus Binance's deeper
 * USDT book. Five sources means the median survives two failing or
 * manipulated venues. */
export function defaultAdapters(): ExchangeAdapter[] {
  return [
    new CoinbaseAdapter(),
    new KrakenAdapter(),
    new GeminiAdapter(),
    new BitstampAdapter(),
    new BinanceAdapter(),
  ];
}
