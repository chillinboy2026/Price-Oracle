import { CapTable, PreferenceSeries } from "./types.js";

/**
 * Cap-table math for turning a headline valuation into a per-share price.
 *
 * This exists because "Series F at a $10B valuation" is not a price. Two
 * things sit between that headline and the number an oracle should publish:
 *
 * 1. **Share count.** $10B post-money over how many shares? Fully-diluted
 *    counts include options already granted, the *unissued* option pool, and
 *    warrants -- and whether you include the unissued pool materially changes
 *    the answer.
 *
 * 2. **Share class.** A priced round prices *preferred*, which carries a
 *    liquidation preference. Common -- what employees hold and what secondary
 *    markets and tokenized exposure actually trade -- is junior to that stack
 *    and is worth strictly less. Publishing the round's headline price per
 *    share as the price of common systematically overstates it.
 *
 * The waterfall below is exact for standard stacks. What it is *not* is a
 * full 409A valuation: real independent valuations run an option-pricing
 * model backsolve across a probability distribution of exit outcomes and then
 * apply a discount for lack of marketability. `expectedCommonPrice` offers a
 * deliberately simplified version of that -- a probability-weighted set of
 * exit scenarios plus an explicit DLOM input -- which is honest about being an
 * approximation rather than pretending to be an OPM.
 */

/** Shares that share in residual value on a fully-diluted basis.
 *
 * Options are counted at full share count without the treasury-stock method
 * (i.e. ignoring the cash their exercise would bring in). That is deliberately
 * conservative: it slightly understates common's value, which is the safer
 * direction for an oracle backing leveraged positions. */
export function fullyDilutedShares(capTable: CapTable): number {
  const preferredShares = capTable.preferred.reduce((sum, series) => sum + series.shares, 0);
  return (
    capTable.commonShares +
    preferredShares +
    capTable.optionsOutstanding +
    capTable.optionPoolUnissued +
    capTable.warrants
  );
}

export interface WaterfallResult {
  /** Total paid out as liquidation preference. */
  preferencePaid: number;
  /** Names of series that converted to common rather than taking preference. */
  convertedSeries: string[];
  /** Residual value per common-equivalent share -- i.e. the common price. */
  commonPricePerShare: number;
  /** Total value flowing to common holders. */
  commonProceeds: number;
}

interface Evaluation {
  perSeriesPreference: Map<string, number>;
  preferencePaid: number;
  residualPerShare: number;
  commonEquivalentShares: number;
}

/** Distributes `exitValue` given a fixed set of converting series. */
function evaluate(exitValue: number, capTable: CapTable, converted: Set<string>): Evaluation {
  const claiming = capTable.preferred.filter((series) => !converted.has(series.name));

  // Seniority tiers are paid highest-first; series sharing a tier are paid
  // pari passu, pro rata to their claims when the tier cannot be paid in full.
  const tiers = [...new Set(claiming.map((s) => s.seniority))].sort((a, b) => b - a);

  const perSeriesPreference = new Map<string, number>();
  let remaining = exitValue;
  let preferencePaid = 0;

  for (const tier of tiers) {
    const tierSeries = claiming.filter((s) => s.seniority === tier);
    const claims = tierSeries.map((s) => s.multiple * s.issuePrice * s.shares);
    const tierClaim = claims.reduce((a, b) => a + b, 0);

    if (tierClaim === 0) continue;

    if (remaining >= tierClaim) {
      tierSeries.forEach((s, i) => perSeriesPreference.set(s.name, claims[i]));
      remaining -= tierClaim;
      preferencePaid += tierClaim;
    } else {
      tierSeries.forEach((s, i) => perSeriesPreference.set(s.name, (remaining * claims[i]) / tierClaim));
      preferencePaid += remaining;
      remaining = 0;
    }
  }

  // Converted preferred and participating preferred both share the residual
  // alongside common; non-participating preferred taking its preference does not.
  let commonEquivalentShares =
    capTable.commonShares + capTable.optionsOutstanding + capTable.optionPoolUnissued + capTable.warrants;
  for (const series of capTable.preferred) {
    if (converted.has(series.name) || series.participating) {
      commonEquivalentShares += series.shares;
    }
  }

  const residualPerShare = commonEquivalentShares > 0 ? remaining / commonEquivalentShares : 0;

  return { perSeriesPreference, preferencePaid, residualPerShare, commonEquivalentShares };
}

/**
 * Distributes `exitValue` across the preference stack and returns what common
 * receives.
 *
 * Non-participating preferred faces a choice at every exit value: take its
 * liquidation preference, or convert to common and share pro rata. Whether
 * conversion pays depends on what *other* series do, so the set of converting
 * series is solved by greedy fixpoint -- repeatedly convert the series that
 * gains most from converting, until none would. This is exact for standard
 * stacks (uniform seniority, 1x non-participating) and a good approximation
 * for layered ones; it is not a general solver for pathological structures.
 */
export function waterfall(exitValue: number, capTable: CapTable): WaterfallResult {
  const converted = new Set<string>();
  const convertible = capTable.preferred.filter((s) => !s.participating);

  for (let iteration = 0; iteration <= convertible.length; iteration++) {
    const current = evaluate(exitValue, capTable, converted);

    let best: { series: PreferenceSeries; gain: number } | null = null;
    for (const series of convertible) {
      if (converted.has(series.name)) continue;
      const preferenceValue = current.perSeriesPreference.get(series.name) ?? 0;

      // Value if this series alone additionally converts.
      const hypothetical = evaluate(exitValue, capTable, new Set([...converted, series.name]));
      const convertValue = hypothetical.residualPerShare * series.shares;

      const gain = convertValue - preferenceValue;
      if (gain > 0 && (best === null || gain > best.gain)) {
        best = { series, gain };
      }
    }

    if (best === null) {
      return {
        preferencePaid: current.preferencePaid,
        convertedSeries: [...converted],
        commonPricePerShare: current.residualPerShare,
        commonProceeds: current.residualPerShare * capTable.commonShares,
      };
    }
    converted.add(best.series.name);
  }

  const final = evaluate(exitValue, capTable, converted);
  return {
    preferencePaid: final.preferencePaid,
    convertedSeries: [...converted],
    commonPricePerShare: final.residualPerShare,
    commonProceeds: final.residualPerShare * capTable.commonShares,
  };
}

/** Price per share of the *preferred* series being issued in a priced round:
 * the headline number, which is simply post-money over fully-diluted shares. */
export function preferredPricePerShare(postMoneyValuation: number, capTable: CapTable): number {
  const shares = fullyDilutedShares(capTable);
  if (shares <= 0) throw new Error("cap table has no shares outstanding");
  return postMoneyValuation / shares;
}

export interface ExitScenario {
  /** Enterprise/equity value at exit. */
  exitValue: number;
  /** Probability weight; the set is normalized, so weights need not sum to 1. */
  probability: number;
}

/**
 * Probability-weighted common price across a set of exit scenarios, optionally
 * discounted for lack of marketability.
 *
 * This is the honest shape of the problem: common's value is not determined by
 * one exit number but by the distribution of them, because the preference
 * stack bites hard in bad outcomes and not at all in good ones. Averaging the
 * waterfall across scenarios captures that asymmetry, which pricing off a
 * single headline valuation does not.
 *
 * It remains a simplification of a real 409A, which would use a full option
 * pricing model backsolved to the last round price. `dlomBps` is an explicit
 * input rather than something derived, precisely so it cannot masquerade as a
 * modelled result.
 */
export function expectedCommonPrice(
  scenarios: ExitScenario[],
  capTable: CapTable,
  dlomBps = 0
): number {
  if (scenarios.length === 0) throw new Error("expectedCommonPrice requires at least one scenario");

  const totalWeight = scenarios.reduce((sum, s) => sum + s.probability, 0);
  if (totalWeight <= 0) throw new Error("scenario probabilities must sum to a positive number");

  const weighted = scenarios.reduce(
    (sum, scenario) => sum + waterfall(scenario.exitValue, capTable).commonPricePerShare * scenario.probability,
    0
  );

  const expected = weighted / totalWeight;
  return expected * (1 - dlomBps / 10_000);
}

/** Ratio of common to preferred price at a given valuation, in bps. Useful as
 * a sanity check: a value near 10000 means the preference stack is immaterial
 * at this valuation, which is the normal case for a healthy company well above
 * its preference overhang. */
export function commonToPreferredRatioBps(postMoneyValuation: number, capTable: CapTable): number {
  const preferred = preferredPricePerShare(postMoneyValuation, capTable);
  if (preferred === 0) return 0;
  const common = waterfall(postMoneyValuation, capTable).commonPricePerShare;
  return (common / preferred) * 10_000;
}

/** Total liquidation preference owed before common receives anything. */
export function preferenceOverhang(capTable: CapTable): number {
  return capTable.preferred.reduce(
    (sum, series) => sum + series.multiple * series.issuePrice * series.shares,
    0
  );
}
