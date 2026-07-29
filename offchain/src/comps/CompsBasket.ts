export interface CompConstituent {
  /** Canonical symbol resolvable by whatever feed supplies prices. */
  symbol: string;
  /** Relative weight. Weights are normalized, so they need not sum to 1. */
  weight: number;
}

export interface CompsBasketConfig {
  name: string;
  constituents: CompConstituent[];
  /** Constituent prices at the index's base date. The index is a weighted
   * average of each name's price *relative* to its base, so it starts at
   * exactly 1.0 and is unaffected by differences in absolute share price. */
  basePrices: Record<string, number>;
  /** Minimum constituents that must have a usable price before the index is
   * publishable. Below this the basket reports nothing, so a partially-broken
   * comp feed degrades the same way a partially-broken exchange feed does. */
  minConstituents: number;
}

export interface CompsIndexValue {
  value: number;
  /** Constituents that actually contributed. */
  contributors: string[];
  /** Combined weight of the contributors, before normalization. */
  coveredWeight: number;
}

/**
 * A basket of public comparables, expressed as a weighted price-relative index
 * normalized to 1.0 at its base date.
 *
 * This exists because a pre-IPO company's value between anchors is not
 * unobservable in the way it first appears. What is unobservable is that
 * *company's* execution. What is very observable is the valuation multiple the
 * public market is paying for companies like it -- and a large part of what
 * moves a private mark between rounds is exactly that sector rerating, not
 * anything the company did.
 *
 * The index is deliberately price-relative rather than price-weighted so that
 * a $600 comp and a $30 comp contribute according to their assigned weight,
 * not according to their share price.
 */
export class CompsBasket {
  private readonly totalWeight: number;

  constructor(private readonly config: CompsBasketConfig) {
    if (config.constituents.length === 0) {
      throw new Error("comps basket requires at least one constituent");
    }
    for (const c of config.constituents) {
      const base = config.basePrices[c.symbol];
      if (base === undefined || !Number.isFinite(base) || base <= 0) {
        throw new Error(`comps basket is missing a positive base price for ${c.symbol}`);
      }
      if (c.weight <= 0) throw new Error(`comps basket weight for ${c.symbol} must be positive`);
    }
    this.totalWeight = config.constituents.reduce((sum, c) => sum + c.weight, 0);
  }

  get name(): string {
    return this.config.name;
  }

  get symbols(): string[] {
    return this.config.constituents.map((c) => c.symbol);
  }

  /**
   * Computes the index from whatever constituent prices are currently
   * available. Missing constituents are dropped and the remaining weights
   * renormalized, so the index stays on the same scale rather than dipping
   * purely because a feed went quiet.
   */
  value(prices: Map<string, number>): CompsIndexValue | null {
    const contributors: string[] = [];
    let weightedRelative = 0;
    let coveredWeight = 0;

    for (const constituent of this.config.constituents) {
      const price = prices.get(constituent.symbol);
      if (price === undefined || !Number.isFinite(price) || price <= 0) continue;

      const base = this.config.basePrices[constituent.symbol];
      weightedRelative += constituent.weight * (price / base);
      coveredWeight += constituent.weight;
      contributors.push(constituent.symbol);
    }

    if (contributors.length < this.config.minConstituents || coveredWeight === 0) return null;

    return {
      value: weightedRelative / coveredWeight,
      contributors,
      coveredWeight: coveredWeight / this.totalWeight,
    };
  }
}
