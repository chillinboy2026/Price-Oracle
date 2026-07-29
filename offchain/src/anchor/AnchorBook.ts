import { AnchorEvent, AnchorKind } from "./types.js";

const SECONDS_PER_DAY = 86_400;

/** How much each kind of event is trusted, and how fast that trust decays.
 *
 * These are not interchangeable pieces of evidence, and treating them as such
 * is the main way a naive pre-IPO oracle goes wrong:
 *
 * - A **priced round** is real money changing hands at an arm's-length
 *   negotiated price. Strongest signal, slowest decay.
 * - A **tender offer** is company-run, broad, and prices common directly --
 *   nearly as good, and more relevant to what tokenized exposure tracks.
 * - A **409A** is an independent formal valuation of common, but deliberately
 *   conservative and backward-looking; it is a floor-ish estimate rather than
 *   a market-clearing price.
 * - A **fund mark** is frequent and independent but modelled, not transacted.
 * - A **secondary** prices common in an actual trade, but is often a single
 *   small lot with idiosyncratic motivation behind it -- wide band.
 * - A **recap** resets the preference stack, which usually means prior
 *   evidence about common is stale; wide band, fast decay.
 */
export interface AnchorKindProfile {
  /** Band half-width in bps at the moment the event takes effect. */
  baseBandBps: number;
  /** Additional band half-width per day of age. */
  wideningBpsPerDay: number;
  /** Reported confidence half-width in bps at t=0. */
  baseConfidenceBps: number;
}

export const DEFAULT_KIND_PROFILES: Record<AnchorKind, AnchorKindProfile> = {
  [AnchorKind.PRICED_ROUND]: { baseBandBps: 1_500, wideningBpsPerDay: 8, baseConfidenceBps: 500 },
  [AnchorKind.TENDER_OFFER]: { baseBandBps: 1_500, wideningBpsPerDay: 9, baseConfidenceBps: 600 },
  [AnchorKind.VALUATION_409A]: { baseBandBps: 2_000, wideningBpsPerDay: 10, baseConfidenceBps: 900 },
  [AnchorKind.FUND_MARK]: { baseBandBps: 2_000, wideningBpsPerDay: 12, baseConfidenceBps: 1_000 },
  [AnchorKind.SECONDARY]: { baseBandBps: 3_000, wideningBpsPerDay: 15, baseConfidenceBps: 1_500 },
  [AnchorKind.RECAP]: { baseBandBps: 3_500, wideningBpsPerDay: 20, baseConfidenceBps: 2_000 },
};

export interface AnchorBookConfig {
  /** Ceiling on band half-width however stale the anchor gets. Must match the
   * `maxBandBps` configured on-chain in AnchorRegistry, or the engine will
   * propose prices the contract rejects. */
  maxBandBps: number;
  maxConfidenceBps: number;
  profiles?: Partial<Record<AnchorKind, AnchorKindProfile>>;
}

export interface AnchorReference {
  /** The anchored fair value the engine mean-reverts toward. */
  price: number;
  /** Half-width of the band the price may occupy around `price`, in bps. */
  bandBps: number;
  /** Reported confidence half-width, in bps. */
  confidenceBps: number;
  /** Age of the underlying event in days. */
  ageDays: number;
  kind: AnchorKind;
}

/**
 * Holds the anchor history for one asset and answers "what is this worth right
 * now, and how sure are we?"
 *
 * The core idea: an anchor's *price* does not decay -- the last round happened
 * at the price it happened at -- but its *authority* does. A round from last
 * month tightly constrains today's value; the same round three years ago
 * barely constrains it at all. So the band widens with age while the anchor
 * price itself stays put, and within that widening band on-chain supply and
 * demand does the price discovery.
 *
 * That is the inversion that makes pre-IPO work at all: for a public stock the
 * live market sets the price and the oracle follows it safely; here real-world
 * evidence sets the *bounds* and order flow sets the price inside them.
 */
export class AnchorBook {
  private readonly events: AnchorEvent[] = [];
  private readonly profiles: Record<AnchorKind, AnchorKindProfile>;

  constructor(private readonly config: AnchorBookConfig) {
    this.profiles = { ...DEFAULT_KIND_PROFILES, ...(config.profiles ?? {}) } as Record<
      AnchorKind,
      AnchorKindProfile
    >;
  }

  /** Records an event. Ordering is by `effectiveAt`, not insertion, since
   * events routinely surface weeks after they took effect. */
  record(event: AnchorEvent): void {
    this.events.push(event);
    this.events.sort((a, b) => a.effectiveAt - b.effectiveAt);
  }

  getEvents(): readonly AnchorEvent[] {
    return this.events;
  }

  /** The most recent anchor as of `now`. Events with a future effective date
   * are ignored rather than applied early. */
  getLatest(now: number): AnchorEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].effectiveAt <= now) return this.events[i];
    }
    return null;
  }

  profileFor(kind: AnchorKind): AnchorKindProfile {
    return this.profiles[kind];
  }

  /** Resolves the current anchored reference, or null if nothing has anchored
   * yet (in which case the engine is unconstrained and the on-chain registry
   * likewise imposes no band). */
  getReference(now: number): AnchorReference | null {
    const anchor = this.getLatest(now);
    if (!anchor) return null;

    const profile = this.profiles[anchor.kind];
    const ageDays = Math.max(0, (now - anchor.effectiveAt) / SECONDS_PER_DAY);

    // The event's own declared band takes precedence over the kind default
    // when it is wider, so an unusually uncertain event can say so.
    const baseBand = Math.max(anchor.bandBps, profile.baseBandBps);

    const bandBps = Math.min(this.config.maxBandBps, baseBand + ageDays * profile.wideningBpsPerDay);
    const confidenceBps = Math.min(
      this.config.maxConfidenceBps,
      profile.baseConfidenceBps + ageDays * profile.wideningBpsPerDay
    );

    return { price: anchor.pricePerShare, bandBps, confidenceBps, ageDays, kind: anchor.kind };
  }

  /** Bounds the price may occupy right now. */
  getBand(now: number): { lower: number; upper: number } | null {
    const reference = this.getReference(now);
    if (!reference) return null;
    return {
      lower: reference.price * (1 - reference.bandBps / 10_000),
      upper: reference.price * (1 + reference.bandBps / 10_000),
    };
  }
}
