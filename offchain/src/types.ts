/** Mirrors PriceAttestationLib.MarketSession in the Solidity contracts. */
export enum MarketSession {
  OFF_HOURS = 0,
  LIVE = 1,
}

export interface LiveFeedQuote {
  /** Human-readable price, e.g. USD per share. */
  price: number;
  /** Unix seconds. */
  timestamp: number;
}

export interface FairPriceState {
  price: number;
  timestamp: number;
  session: MarketSession;
  nonce: bigint;
  reopenStepsRemaining: number;
}

export interface FairPriceResult {
  price: number;
  timestamp: number;
  session: MarketSession;
  nonce: bigint;
  confidenceBps: number;
}
