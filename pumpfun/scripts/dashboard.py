#!/usr/bin/env python3
"""Live view: open positions, today's funnel, recent events."""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.log import read_records  # noqa: E402


def today() -> str:
    return datetime.now(tz=UTC).strftime("%Y-%m-%d")


def render(log_path: str, state_path: str) -> str:
    records = list(read_records(log_path))
    todays = [r for r in records if str(r.get("timestamp", "")).startswith(today())]

    lines = ["", "=" * 64, f"  pump.fun pipeline -- {today()} UTC", "=" * 64, ""]

    state_file = Path(state_path)
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text())
        except (OSError, json.JSONDecodeError):
            state = {}
        positions = state.get("positions", [])
        lines.append(f"  open positions: {len(positions)}")
        for position in positions:
            age = (time.time() - float(position.get("opened_at", time.time()))) / 60
            entry = float(position.get("entry_price", 0.0))
            peak = float(position.get("peak_price", 0.0))
            from_peak = (peak - entry) / entry * 100 if entry else 0.0
            lines.append(
                f"    {position.get('symbol') or position.get('mint', '')[:8]:<12}"
                f" {position.get('sol_spent', 0):.4f} SOL"
                f"  {age:>5.0f}m  peak {from_peak:+.0f}%"
            )
        lines.append(f"  today: {state.get('today_trades', 0)} trades, "
                     f"{state.get('today_loss_sol', 0.0):.4f} SOL lost")
    else:
        lines.append("  (no state file yet)")

    buys = [r for r in todays if r.get("action") == "buy"]
    skips = [r for r in todays if r.get("action") == "skip"]
    closes = [r for r in todays if r.get("action") == "close"]

    lines += ["", f"  today: {len(skips) + len(buys)} considered, "
                  f"{len(buys)} bought, {len(closes)} closed"]

    if skips:
        lines.append("")
        for reason, count in Counter(str(r.get("reason")) for r in skips).most_common(6):
            lines.append(f"    {reason:<26} {count:>5}")

    recent = [r for r in records if r.get("action") in ("buy", "close")][-8:]
    if recent:
        lines += ["", "  recent:"]
        for record in recent:
            stamp = str(record.get("timestamp", ""))[11:19]
            if record["action"] == "buy":
                lines.append(f"    {stamp}  BUY   {record.get('symbol', ''):<12}"
                             f" {record.get('amount_sol', 0):.4f} SOL"
                             f"  score {record.get('score', 0):.2f}")
            else:
                lines.append(f"    {stamp}  CLOSE {record.get('symbol', ''):<12}"
                             f" {record.get('pnl_pct', 0):+.1f}%"
                             f"  {record.get('reason', '')}")

    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", nargs="?", default="logs/trades.jsonl")
    parser.add_argument("--state", default="state/pipeline.json")
    parser.add_argument("--watch", type=float, metavar="SECONDS",
                        help="redraw every N seconds")
    args = parser.parse_args(argv)

    if not args.watch:
        print(render(args.log, args.state))
        return 0

    try:
        while True:
            print("\033[2J\033[H" + render(args.log, args.state))
            time.sleep(args.watch)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
