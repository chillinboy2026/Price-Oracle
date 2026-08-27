#!/usr/bin/env python3
"""Summarise a trade log: what was seen, what was skipped, what it earned.

Reads the JSONL log written by the pipeline and prints where the stream
was lost, how scores were distributed, and the PnL of closed positions.
"""

from __future__ import annotations

import argparse
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.log import read_records  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", nargs="?", default="logs/trades.jsonl")
    args = parser.parse_args(argv)

    records = list(read_records(args.log))
    if not records:
        print(f"no records in {args.log}")
        return 1

    buys = [r for r in records if r.get("action") == "buy"]
    skips = [r for r in records if r.get("action") == "skip"]
    closes = [r for r in records if r.get("action") == "close"]

    print(f"\n{'=' * 66}")
    print(f"  {args.log}")
    print(f"{'=' * 66}\n")
    print(f"  considered   {len(skips) + len(buys):>8}")
    print(f"  bought       {len(buys):>8}")
    print(f"  closed       {len(closes):>8}")

    considered = len(skips) + len(buys)
    if considered:
        print(f"  hit rate     {len(buys) / considered:>8.2%}")

    # -- where the stream was lost -----------------------------------------

    by_stage: dict[str, Counter[str]] = defaultdict(Counter)
    for record in skips:
        by_stage[str(record.get("stage", "?"))][str(record.get("reason", "?"))] += 1

    if by_stage:
        print(f"\n  {'-' * 62}")
        print("  where the stream was lost")
        print(f"  {'-' * 62}")
        order = ["filter", "memory", "analyzer", "scoring", "checker", "risk", "execution"]
        for stage in sorted(by_stage, key=lambda s: order.index(s) if s in order else 99):
            total = sum(by_stage[stage].values())
            print(f"\n  {stage}  ({total})")
            for reason, count in by_stage[stage].most_common():
                bar = "#" * min(40, int(40 * count / max(total, 1)))
                print(f"    {reason:<26} {count:>6}  {bar}")

    # -- scores ------------------------------------------------------------

    scored = [r for r in records if isinstance(r.get("score"), (int, float))]
    if scored:
        values = [float(r["score"]) for r in scored]
        print(f"\n  {'-' * 62}")
        print("  score distribution")
        print(f"  {'-' * 62}")
        buckets = Counter(min(9, int(value * 10)) for value in values)
        for bucket in range(10):
            count = buckets.get(bucket, 0)
            bar = "#" * min(40, count)
            print(f"    {bucket / 10:.1f}-{bucket / 10 + 0.1:.1f}  {count:>6}  {bar}")
        print(f"\n    mean {statistics.mean(values):.3f}  "
              f"median {statistics.median(values):.3f}  max {max(values):.3f}")

        components = defaultdict(list)
        for record in scored:
            for name, value in (record.get("components") or {}).items():
                components[name].append(float(value))
        if components:
            print("\n    mean by component:")
            for name in ("audit", "narrative", "timing", "metrics"):
                if components.get(name):
                    print(f"      {name:<10} {statistics.mean(components[name]):.3f}")

    # -- outcomes ----------------------------------------------------------

    if closes:
        pnls = [float(r.get("pnl_sol", 0.0)) for r in closes]
        pcts = [float(r.get("pnl_pct", 0.0)) for r in closes]
        holds = [float(r.get("hold_seconds", 0.0)) for r in closes]
        winners = [p for p in pnls if p > 0]

        print(f"\n  {'-' * 62}")
        print("  outcomes")
        print(f"  {'-' * 62}")
        print(f"    net            {sum(pnls):+.4f} SOL")
        print(f"    win rate       {len(winners) / len(pnls):.1%} "
              f"({len(winners)}/{len(pnls)})")
        print(f"    best / worst   {max(pcts):+.1f}% / {min(pcts):+.1f}%")
        print(f"    median hold    {statistics.median(holds) / 60:.1f} min")

        reasons = Counter(str(r.get("reason", "?")) for r in closes)
        print("\n    exits:")
        for reason, count in reasons.most_common():
            share = [float(r.get("pnl_sol", 0)) for r in closes
                     if r.get("reason") == reason]
            print(f"      {reason:<16} {count:>4}   {sum(share):+.4f} SOL")

        if len(closes) < 30:
            print(f"\n  note: {len(closes)} closed trades is too few to conclude "
                  "anything.\n  This describes what happened, not what will.")

    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
