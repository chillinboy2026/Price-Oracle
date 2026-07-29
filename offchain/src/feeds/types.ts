import { LiveFeedQuote } from "../types.js";

export interface LiveFeed {
  /** Returns the current live quote, or null if the reference market is
   * closed (nights, weekends, holidays) -- the caller's cue to fall back to
   * the off-hours synthetic model. */
  quote(now: Date): LiveFeedQuote | null;
}
