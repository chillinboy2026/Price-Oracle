import { describe, expect, it } from "vitest";
import { AnchorBook, DEFAULT_KIND_PROFILES } from "../src/anchor/AnchorBook.js";
import { AnchorKind } from "../src/anchor/types.js";

const DAY = 86_400;
const T0 = 1_800_000_000;

function book() {
  return new AnchorBook({ maxBandBps: 5_000, maxConfidenceBps: 3_000 });
}

describe("AnchorBook", () => {
  it("returns no reference before anything has anchored", () => {
    expect(book().getReference(T0)).toBeNull();
    expect(book().getBand(T0)).toBeNull();
  });

  it("uses the most recent effective anchor", () => {
    const b = book();
    b.record({ kind: AnchorKind.PRICED_ROUND, pricePerShare: 10, shareClass: "COMMON", effectiveAt: T0 - 200 * DAY, bandBps: 1_500 });
    b.record({ kind: AnchorKind.TENDER_OFFER, pricePerShare: 18, shareClass: "COMMON", effectiveAt: T0 - 10 * DAY, bandBps: 1_500 });

    expect(b.getReference(T0)!.price).toBe(18);
    expect(b.getReference(T0)!.kind).toBe(AnchorKind.TENDER_OFFER);
  });

  it("orders by effective date, not insertion order", () => {
    const b = book();
    // A tender offer from 10 days ago is reported *after* a later 409A.
    b.record({ kind: AnchorKind.VALUATION_409A, pricePerShare: 15, shareClass: "COMMON", effectiveAt: T0 - 5 * DAY, bandBps: 2_000 });
    b.record({ kind: AnchorKind.TENDER_OFFER, pricePerShare: 18, shareClass: "COMMON", effectiveAt: T0 - 10 * DAY, bandBps: 1_500 });

    // The 409A is still the most recent evidence.
    expect(b.getReference(T0)!.price).toBe(15);
  });

  it("ignores anchors whose effective date has not arrived", () => {
    const b = book();
    b.record({ kind: AnchorKind.PRICED_ROUND, pricePerShare: 10, shareClass: "COMMON", effectiveAt: T0 - DAY, bandBps: 1_500 });
    b.record({ kind: AnchorKind.PRICED_ROUND, pricePerShare: 30, shareClass: "COMMON", effectiveAt: T0 + 30 * DAY, bandBps: 1_500 });

    expect(b.getReference(T0)!.price).toBe(10);
    expect(b.getReference(T0 + 31 * DAY)!.price).toBe(30);
  });

  it("holds the anchor price fixed while widening its band with age", () => {
    const b = book();
    b.record({ kind: AnchorKind.PRICED_ROUND, pricePerShare: 20, shareClass: "COMMON", effectiveAt: T0, bandBps: 1_500 });

    const fresh = b.getReference(T0)!;
    const aged = b.getReference(T0 + 100 * DAY)!;

    // The round happened at the price it happened at; only its authority decays.
    expect(fresh.price).toBe(20);
    expect(aged.price).toBe(20);
    expect(aged.bandBps).toBeGreaterThan(fresh.bandBps);

    const profile = DEFAULT_KIND_PROFILES[AnchorKind.PRICED_ROUND];
    expect(aged.bandBps).toBeCloseTo(1_500 + 100 * profile.wideningBpsPerDay, 6);
  });

  it("caps band and confidence widening however stale the anchor gets", () => {
    const b = book();
    b.record({ kind: AnchorKind.PRICED_ROUND, pricePerShare: 20, shareClass: "COMMON", effectiveAt: T0, bandBps: 1_500 });

    const ancient = b.getReference(T0 + 10_000 * DAY)!;
    expect(ancient.bandBps).toBe(5_000);
    expect(ancient.confidenceBps).toBe(3_000);
  });

  it("trusts a priced round more than a one-off secondary", () => {
    const priced = book();
    priced.record({ kind: AnchorKind.PRICED_ROUND, pricePerShare: 20, shareClass: "COMMON", effectiveAt: T0, bandBps: 0 });

    const secondary = book();
    secondary.record({ kind: AnchorKind.SECONDARY, pricePerShare: 20, shareClass: "COMMON", effectiveAt: T0, bandBps: 0 });

    const p = priced.getReference(T0)!;
    const s = secondary.getReference(T0)!;

    expect(s.bandBps).toBeGreaterThan(p.bandBps);
    expect(s.confidenceBps).toBeGreaterThan(p.confidenceBps);
  });

  it("honours an unusually wide band declared on the event itself", () => {
    const b = book();
    // The event says it is less certain than its kind normally implies.
    b.record({ kind: AnchorKind.PRICED_ROUND, pricePerShare: 20, shareClass: "COMMON", effectiveAt: T0, bandBps: 4_000 });
    expect(b.getReference(T0)!.bandBps).toBe(4_000);
  });

  it("computes concrete price bounds", () => {
    const b = book();
    b.record({ kind: AnchorKind.PRICED_ROUND, pricePerShare: 20, shareClass: "COMMON", effectiveAt: T0, bandBps: 1_500 });

    const band = b.getBand(T0)!;
    expect(band.lower).toBeCloseTo(17, 9);
    expect(band.upper).toBeCloseTo(23, 9);
  });
});
