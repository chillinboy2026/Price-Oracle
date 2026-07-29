import { median } from "../aggregation/median.js";
import { LiveFeedQuote } from "../types.js";
import { DEFAULT_HTTP_CONFIG, FetchLike, HttpConfig } from "../util/http.js";
import { ExchangeAdapter, ExchangeQuote } from "./exchanges/types.js";
import { LiveFeed } from "./types.js";

export interface AggregatedLiveFeedConfig {
  /** Canonical symbol, e.g. "BTC-USD". Each adapter maps it to its own ticker. */
  symbol: string;
  adapters: ExchangeAdapter[];
  /** Minimum venues that must agree before a price is published at all.
   * Below this the feed reports no quote rather than a weakly-sourced one,
   * which downstream is treated exactly like a closed market. */
  minSources: number;
  pollIntervalMs: number;
  /** How long a cached aggregate stays usable. Past this the feed reports no
   * quote, so a silently dead poller degrades to the off-hours model instead
   * of serving an indefinitely stale price. */
  maxQuoteAgeMs: number;
  /** Venues whose book is wider than this are dropped: a blown-out spread
   * means thin or broken liquidity, and its midpoint is cheap to move. */
  maxSpreadBps: number;
  /** Venues further than this from the cross-venue median are dropped as
   * outliers before the final median is taken. */
  maxDeviationBps: number;
  http?: HttpConfig;
  fetchImpl?: FetchLike;
  onEvent?: (event: FeedEvent) => void;
}

export type FeedEvent =
  | { kind: "source_failed"; source: string; error: string }
  | { kind: "source_rejected"; source: string; reason: string; price: number }
  | { kind: "quorum_failed"; healthy: number; required: number }
  | { kind: "aggregated"; price: number; sources: string[] };

export interface SourceHealth {
  source: string;
  lastOkAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface FeedSnapshot {
  price: number;
  /** Unix seconds this aggregate was computed. */
  timestamp: number;
  sources: string[];
}

/**
 * A live market feed backed by several real exchanges at once.
 *
 * Polls every configured venue in parallel on its own schedule and caches the
 * aggregate; `quote()` stays synchronous and just reads that cache, which
 * keeps the pricing engine's tick rate decoupled from exchange rate limits and
 * lets the engine remain a pure synchronous function of its inputs.
 *
 * Aggregation is deliberately median-based rather than mean-based, and runs in
 * two passes: take a provisional median, drop venues too far from it, then
 * re-median what survives. A single compromised or broken venue therefore
 * cannot move the published price at all -- it is either outvoted by the
 * median or discarded as an outlier before the median is taken.
 *
 * When fewer than `minSources` venues survive, the feed reports *no quote*
 * rather than a poorly-sourced one. Downstream that is indistinguishable from
 * a closed market, so the engine falls back to its bounded off-hours model and
 * the oracle contract applies its tighter off-hours guardrail -- meaning a
 * crypto exchange outage degrades along exactly the same path as an equity
 * market's overnight session, with no special-casing.
 */
export class AggregatedLiveFeed implements LiveFeed {
  private snapshot: FeedSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly health = new Map<string, SourceHealth>();

  constructor(private readonly config: AggregatedLiveFeedConfig) {
    for (const adapter of config.adapters) {
      this.health.set(adapter.name, {
        source: adapter.name,
        lastOkAt: null,
        consecutiveFailures: 0,
        lastError: null,
      });
    }
  }

  /** Begins background polling and resolves once the first poll completes, so
   * callers can await a warm cache instead of racing an empty one. */
  async start(): Promise<void> {
    if (this.timer) return;
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.config.pollIntervalMs);
    // Do not hold the event loop open purely for price polling.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getHealth(): SourceHealth[] {
    return [...this.health.values()];
  }

  getSnapshot(): FeedSnapshot | null {
    return this.snapshot;
  }

  quote(now: Date): LiveFeedQuote | null {
    if (!this.snapshot) return null;
    const ageMs = now.getTime() - this.snapshot.timestamp * 1000;
    if (ageMs > this.config.maxQuoteAgeMs) return null;
    return { price: this.snapshot.price, timestamp: this.snapshot.timestamp };
  }

  /** Runs one aggregation round. Safe to call directly in tests; overlapping
   * calls are skipped so a slow venue cannot pile up concurrent polls. */
  async poll(): Promise<FeedSnapshot | null> {
    if (this.polling) return this.snapshot;
    this.polling = true;
    try {
      const quotes = await this.collect();
      const kept = this.filterOutliers(this.filterWideSpreads(quotes));

      if (kept.length < this.config.minSources) {
        this.emit({ kind: "quorum_failed", healthy: kept.length, required: this.config.minSources });
        // Leave the previous snapshot in place; `quote()`'s staleness check is
        // what ultimately retires it, so a single failed round does not
        // immediately blind the engine.
        return this.snapshot;
      }

      const price = median(kept.map((q) => q.price));
      const sources = kept.map((q) => q.source);
      this.snapshot = { price, timestamp: Math.floor(Date.now() / 1000), sources };
      this.emit({ kind: "aggregated", price, sources });
      return this.snapshot;
    } finally {
      this.polling = false;
    }
  }

  private async collect(): Promise<ExchangeQuote[]> {
    const http = this.config.http ?? DEFAULT_HTTP_CONFIG;

    const results = await Promise.allSettled(
      this.config.adapters.map((adapter) =>
        adapter.fetchQuote(this.config.symbol, http, this.config.fetchImpl)
      )
    );

    const quotes: ExchangeQuote[] = [];
    results.forEach((result, index) => {
      const adapter = this.config.adapters[index];
      const health = this.health.get(adapter.name)!;

      if (result.status === "fulfilled") {
        health.lastOkAt = Math.floor(Date.now() / 1000);
        health.consecutiveFailures = 0;
        health.lastError = null;
        quotes.push(result.value);
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        health.consecutiveFailures += 1;
        health.lastError = message;
        this.emit({ kind: "source_failed", source: adapter.name, error: message });
      }
    });

    return quotes;
  }

  private filterWideSpreads(quotes: ExchangeQuote[]): ExchangeQuote[] {
    return quotes.filter((quote) => {
      if (quote.spreadBps === undefined) return true;
      if (quote.spreadBps <= this.config.maxSpreadBps) return true;
      this.emit({
        kind: "source_rejected",
        source: quote.source,
        reason: `spread ${quote.spreadBps.toFixed(1)}bps exceeds ${this.config.maxSpreadBps}bps`,
        price: quote.price,
      });
      return false;
    });
  }

  private filterOutliers(quotes: ExchangeQuote[]): ExchangeQuote[] {
    if (quotes.length < 3) return quotes; // too few to identify an outlier meaningfully

    const provisional = median(quotes.map((q) => q.price));
    return quotes.filter((quote) => {
      const deviation = (Math.abs(quote.price - provisional) / provisional) * 10_000;
      if (deviation <= this.config.maxDeviationBps) return true;
      this.emit({
        kind: "source_rejected",
        source: quote.source,
        reason: `${deviation.toFixed(1)}bps from cross-venue median ${provisional.toFixed(2)}`,
        price: quote.price,
      });
      return false;
    });
  }

  private emit(event: FeedEvent): void {
    this.config.onEvent?.(event);
  }
}
