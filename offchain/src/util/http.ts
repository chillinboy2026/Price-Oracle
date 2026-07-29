export interface HttpConfig {
  /** Per-attempt timeout. Exchange REST endpoints are normally <300ms; a
   * multi-second hang means the venue is degraded and we would rather drop it
   * from this poll than stall the whole aggregation behind it. */
  timeoutMs: number;
  /** Retries *after* the first attempt. Kept low: a price feed's value decays
   * fast, so it is better to skip a venue this round than to keep retrying a
   * quote that is going stale while we wait. */
  retries: number;
  retryBaseDelayMs: number;
}

export const DEFAULT_HTTP_CONFIG: HttpConfig = {
  timeoutMs: 4_000,
  retries: 2,
  retryBaseDelayMs: 250,
};

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/** 5xx and 429 are worth another attempt; other 4xx mean the request itself is
 * wrong (bad symbol, removed endpoint) and retrying just burns rate limit. */
function isRetriableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GETs `url` and parses JSON, with a per-attempt timeout and bounded
 * exponential backoff. `fetchImpl` is injectable so tests can drive it against
 * a local server (or a stub) without touching the network.
 */
export async function fetchJson<T>(
  url: string,
  config: HttpConfig = DEFAULT_HTTP_CONFIG,
  fetchImpl: FetchLike = fetch
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (attempt > 0) {
      await sleep(config.retryBaseDelayMs * 2 ** (attempt - 1));
    }

    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(config.timeoutMs) });

      if (!response.ok) {
        const error = new HttpError(response.status, url, `GET ${url} failed with ${response.status}`);
        if (!isRetriableStatus(response.status)) throw error;
        lastError = error;
        continue;
      }

      return (await response.json()) as T;
    } catch (err) {
      // A non-retriable HttpError propagates immediately; anything else
      // (timeout, DNS, connection reset, malformed JSON) gets another attempt.
      if (err instanceof HttpError && !isRetriableStatus(err.status)) throw err;
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`GET ${url} failed: ${String(lastError)}`);
}
