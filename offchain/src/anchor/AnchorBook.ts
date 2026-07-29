import { compsAdjustmentFactor } from "../comps/beta.js";
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
  /** Sensitivity to the comparables index, in bps (10000 = 1:1). Must match
   * the on-chain `betaBps`. */
  betaBps?: number;
  /** Cap on how far comps alone may move the band center, in bps. Must match
   * the on-chain `maxCompAdjustmentBps`. */
  maxCompAdjustmentBps?: number;
  profiles?: Partial<Record<AnchorKind, AnchorKindProfile>>;
}

export interface AnchorReference {
  /** The anchored fair value the engine mean-reverts toward: the anchor price
   * carried forward by comparables. */
  price: number;
  /** The raw anchor price, before any comps adjustment. */
  anchorPrice: number;
  /** Multiplier comps contributed, 1 when comps tracking is inactive. */
  compAdjustment: number;
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

  /**
   * Resolves the current anchored reference, or null if nothing has anchored
   * yet (in which case the engine is unconstrained and the on-chain registry
   * likewise imposes no band).
   *
   * `compIndexNow` is the current level of the public comparables index. When
   * supplied -- and when the anchor recorded the index level at its effective
   * date -- the reference is recentered by how far comps have moved since,
   * scaled by beta. This reproduces `AnchorRegistry.currentCenter()` exactly,
   * including the clamp, so the engine never proposes a price the contract
   * would reject.
   */
  getReference(now: number, compIndexNow?: number): AnchorReference | null {
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

    const compAdjustment =
      compIndexNow !== undefined &&
      anchor.compIndexAtEffective !== undefined &&
      anchor.compIndexAtEffective > 0
        ? compsAdjustmentFactor(
            compIndexNow,
            anchor.compIndexAtEffective,
            this.config.betaBps ?? 0,
            this.config.maxCompAdjustmentBps ?? 0
          )
        : 1;

    return {
      price: anchor.pricePerShare * compAdjustment,
      anchorPrice: anchor.pricePerShare,
      compAdjustment,
      bandBps,
      confidenceBps,
      ageDays,
      kind: anchor.kind,
    };
  }

  /** Bounds the price may occupy right now, centered on the comps-adjusted
   * reference. */
  getBand(now: number, compIndexNow?: number): { lower: number; upper: number } | null {
    const reference = this.getReference(now, compIndexNow);
    if (!reference) return null;
    return {
      lower: reference.price * (1 - reference.bandBps / 10_000),
      upper: reference.price * (1 + reference.bandBps / 10_000),
    };
  }
}
