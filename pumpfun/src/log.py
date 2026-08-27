"""JSONL decision log.

One JSON object per line, three record types: ``buy``, ``skip``, ``close``.

Every ``buy`` carries the full decision context -- the score broken into
components, all four agent replies, the metrics. That is deliberate: with
the components stored, history can be re-scored under different weights
later without calling a single agent again. A log that kept only the total
could never answer "would a different weighting have done better".

Rotation is by size, because a pipeline left running for weeks will
otherwise fill the disk.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .models import (
    Analysis,
    AuditResult,
    CheckerResult,
    NarrativeResult,
    Position,
    ScoreBreakdown,
    TimingResult,
    Token,
)

log = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(tz=UTC).isoformat()


class TradeLog:
    """Append-only JSONL with size-based rotation."""

    def __init__(self, path: str | Path, max_bytes: int = 50 * 1024 * 1024,
                 backups: int = 5) -> None:
        self.path = Path(path)
        self.max_bytes = max_bytes
        self.backups = backups
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.counts: dict[str, int] = {"buy": 0, "skip": 0, "close": 0}

    # -- writing -----------------------------------------------------------

    def _write(self, record: dict[str, Any]) -> None:
        line = json.dumps(record, ensure_ascii=False, default=str)
        with self._lock:
            self._rotate_if_needed(len(line) + 1)
            try:
                with self.path.open("a", encoding="utf-8") as stream:
                    stream.write(line + "\n")
            except OSError as exc:
                # A log write must never take the pipeline down, but a
                # silent failure would leave no record of trades that
                # actually happened, so it is loud.
                log.error("could not write trade log: %s", exc)
                return
        action = str(record.get("action", ""))
        self.counts[action] = self.counts.get(action, 0) + 1

    def _rotate_if_needed(self, incoming: int) -> None:
        try:
            size = self.path.stat().st_size
        except OSError:
            return
        if size + incoming <= self.max_bytes:
            return
        for index in range(self.backups - 1, 0, -1):
            older = self.path.with_suffix(self.path.suffix + f".{index}")
            newer = self.path.with_suffix(self.path.suffix + f".{index + 1}")
            if older.exists():
                os.replace(older, newer)
        if self.backups > 0:
            os.replace(self.path, self.path.with_suffix(self.path.suffix + ".1"))
        else:
            self.path.unlink(missing_ok=True)
        log.info("rotated trade log at %d bytes", size)

    # -- record types ------------------------------------------------------

    def buy(
        self,
        token: Token,
        position: Position,
        score: ScoreBreakdown,
        analysis: Analysis,
        audit: AuditResult,
        narrative: NarrativeResult,
        timing: TimingResult,
        checker: CheckerResult,
        mode: str,
    ) -> None:
        self._write({
            "timestamp": _now(),
            "action": "buy",
            "mode": mode,
            "token": token.mint,
            "name": token.name,
            "symbol": token.symbol,
            "creator": token.creator,
            "score": score.total,
            "components": {
                "audit": score.audit,
                "narrative": score.narrative,
                "timing": score.timing,
                "metrics": score.metrics,
            },
            "metrics": analysis.summary(),
            "audit": audit.model_dump(),
            "narrative": narrative.model_dump(),
            "timing": timing.model_dump(exclude={"computed_at"}),
            "checker": checker.model_dump(),
            "curve_pct_at_buy": token.bonding_curve_pct,
            "entry_price": position.entry_price,
            "amount_sol": position.sol_spent,
            "token_amount": position.token_amount,
            "tx_hash": position.tx_hash,
        })

    def skip(self, token: Token, stage: str, reason: str,
             detail: Any = None, score: ScoreBreakdown | None = None) -> None:
        record: dict[str, Any] = {
            "timestamp": _now(),
            "action": "skip",
            "token": token.mint,
            "name": token.name,
            "symbol": token.symbol,
            "creator": token.creator,
            "stage": stage,
            "reason": reason,
            "detail": detail,
        }
        if score is not None:
            record["score"] = score.total
            record["components"] = {
                "audit": score.audit,
                "narrative": score.narrative,
                "timing": score.timing,
                "metrics": score.metrics,
            }
            record["weakest"] = score.weakest
        self._write(record)

    def close(self, position: Position, exit_price: float, pnl_sol: float,
              pnl_pct: float, reason: str, tx_hash: str = "") -> None:
        self._write({
            "timestamp": _now(),
            "action": "close",
            "token": position.mint,
            "symbol": position.symbol,
            "creator": position.creator,
            "reason": reason,
            "entry_price": position.entry_price,
            "exit_price": exit_price,
            "peak_price": position.peak_price,
            "pnl_sol": round(pnl_sol, 6),
            "pnl_pct": round(pnl_pct, 2),
            "hold_seconds": round(position.hold_seconds, 1),
            "score_at_entry": position.score,
            "tx_hash": tx_hash,
        })


def read_records(path: str | Path) -> Iterator[dict[str, Any]]:
    """Stream a JSONL log, skipping unreadable lines.

    A truncated final line is normal if the process was killed mid-write;
    it should not stop the rest of the file from being analysed.
    """
    target = Path(path)
    if not target.exists():
        return
    with target.open(encoding="utf-8") as stream:
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                yield record
