#!/usr/bin/env python3
"""Re-score history under different weights and thresholds.

Every log record stores its score components, so history can be re-scored
without calling a single agent again.

The limitation this prints for itself, because it is the whole caveat:
**the log cannot know how a token rejected by the threshold would have
turned out.** This table describes trades that happened. It is not a
backtest, and on a couple of dozen closed trades it is fitting noise.
"""

from __future__ import annotations

import argparse
import itertools
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.log import read_records  # noqa: E402
from src.scoring import rescore  # noqa: E402

MIN_SAMPLE = 30


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", nargs="?", default="logs/trades.jsonl")
    parser.add_argument("--grid", type=int, default=3,
                        help="weight values per component to try")
    args = parser.parse_args(argv)

    records = list(read_records(args.log))
    buys = {r["token"]: r for r in records
            if r.get("action") == "buy" and r.get("components")}
    closes = {r["token"]: r for r in records if r.get("action") == "close"}

    paired = [(buys[mint], closes[mint]) for mint in buys if mint in closes]
    if not paired:
        print("no closed trades with stored components yet.")
        return 1

    print(f"\n  {len(paired)} closed trades with full component data\n")
    if len(paired) < MIN_SAMPLE:
        print(f"  WARNING: fewer than {MIN_SAMPLE} closed trades. Anything below")
        print("  is curve-fitting to noise, not a tuned parameter.\n")

    # -- threshold sweep ---------------------------------------------------

    print(f"  {'-' * 58}")
    print("  threshold sweep (on trades that were actually taken)")
    print(f"  {'-' * 58}")
    print(f"  {'threshold':>10} {'kept':>6} {'net SOL':>10} {'win rate':>10}")

    for threshold in [round(0.3 + 0.05 * i, 2) for i in range(11)]:
        kept = [(b, c) for b, c in paired if float(b.get("score", 0)) >= threshold]
        if not kept:
            continue
        net = sum(float(c.get("pnl_sol", 0)) for _, c in kept)
        wins = sum(1 for _, c in kept if float(c.get("pnl_sol", 0)) > 0)
        print(f"  {threshold:>10.2f} {len(kept):>6} {net:>+10.4f} "
              f"{wins / len(kept):>9.0%}")

    # -- weight grid -------------------------------------------------------

    print(f"\n  {'-' * 58}")
    print("  weight sets, ranked by net on these same trades")
    print(f"  {'-' * 58}")

    steps = [round(0.1 + 0.4 * i / max(args.grid - 1, 1), 2) for i in range(args.grid)]
    results = []
    for audit, narrative, timing, metrics in itertools.product(steps, repeat=4):
        weights = {"audit": audit, "narrative": narrative,
                   "timing": timing, "metrics": metrics}
        kept = [
            (b, c) for b, c in paired
            if rescore(b["components"], weights) >= 0.5
        ]
        if not kept:
            continue
        net = sum(float(c.get("pnl_sol", 0)) for _, c in kept)
        results.append((net, len(kept), weights))

    results.sort(reverse=True, key=lambda item: item[0])
    print(f"  {'audit':>7} {'narr':>7} {'timing':>7} {'metrics':>8} "
          f"{'kept':>6} {'net SOL':>10}")
    for net, kept, weights in results[:8]:
        print(f"  {weights['audit']:>7.2f} {weights['narrative']:>7.2f} "
              f"{weights['timing']:>7.2f} {weights['metrics']:>8.2f} "
              f"{kept:>6} {net:>+10.4f}")

    print("\n  Reminder: every row above is scored only on tokens the live")
    print("  threshold already let through. What the rejected ones would")
    print("  have done is not in this log and cannot be.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
