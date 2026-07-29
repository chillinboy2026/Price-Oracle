/** Mirrors AnchorAttestationLib.AnchorKind in the Solidity contracts. */
export enum AnchorKind {
  PRICED_ROUND = 0,
  SECONDARY = 1,
  TENDER_OFFER = 2,
  VALUATION_409A = 3,
  FUND_MARK = 4,
  RECAP = 5,
}

export type ShareClass = "COMMON" | "PREFERRED";

/** One series in the liquidation preference stack. */
export interface PreferenceSeries {
  name: string;
  /** Shares issued in this series. */
  shares: number;
  /** Price paid per share at issuance. */
  issuePrice: number;
  /** Preference multiple, e.g. 1 for a standard 1x. */
  multiple: number;
  /** Participating preferred takes its preference *and* converts pro rata.
   * Non-participating takes the greater of the two. Standard VC terms are
   * non-participating; participating stacks materially depress common. */
  participating: boolean;
  /** Higher seniority is paid first. Series with equal seniority share pari
   * passu, which is the common case for a straightforward stack. */
  seniority: number;
}

export interface CapTable {
  commonShares: number;
  /** Preference stack, newest/most senior typically last-issued. */
  preferred: PreferenceSeries[];
  /** Vested and unvested options already granted. */
  optionsOutstanding: number;
  /** Authorized but ungranted pool. Included in fully-diluted counts because
   * a new round almost always requires the pool to be topped up pre-money,
   * diluting existing holders. */
  optionPoolUnissued: number;
  warrants: number;
}

export interface AnchorEvent {
  kind: AnchorKind;
  /** Price per share of `shareClass`. */
  pricePerShare: number;
  shareClass: ShareClass;
  /** Unix seconds when the event took effect (not when it was reported). */
  effectiveAt: number;
  /** Headline post-money valuation, if the event implies one. */
  impliedValuation?: number;
  /** Half-width of the acceptable band at t=0, in bps. */
  bandBps: number;
  /** Hash/CID of the supporting document. */
  documentHash?: string;
}
