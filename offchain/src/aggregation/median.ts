/**
 * Median of independently observed candidate prices. Reporters each run
 * their own FairPriceEngine on their own (slightly noisy) view of the live
 * feed, so their candidates won't be bit-identical; a single canonical value
 * has to be agreed before anyone can sign the same EIP-712 struct. Median
 * (rather than mean) keeps one outlier/faulty/malicious reporter from
 * skewing the canonical price.
 */
export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median() requires at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
