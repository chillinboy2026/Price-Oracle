"""State that outlives the process.

Without this file a restart would reset the daily loss limit and forget
every open position -- meaning the two brakes that matter most would
silently reset themselves every time the process bounced, and a crash-loop
would trade without limit.

Writes are atomic: a temp file in the same directory, then ``os.replace``.
A half-written JSON file on disk is never a state this can be left in.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from .models import Position
from .risk import RiskManager, utc_day

log = logging.getLogger(__name__)


class PipelineState:
    """Open positions, daily counters, and the mints already traded."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.positions: dict[str, Position] = {}
        self.traded_mints: set[str] = set()
        self.day: str = utc_day()
        self.today_loss_sol: float = 0.0
        self.today_profit_sol: float = 0.0
        self.today_trades: int = 0

    # -- persistence -------------------------------------------------------

    def save(self) -> None:
        payload = {
            "day": self.day,
            "today_loss_sol": self.today_loss_sol,
            "today_profit_sol": self.today_profit_sol,
            "today_trades": self.today_trades,
            "positions": [p.model_dump() for p in self.positions.values()],
            # Bounded: only the most recent matter, and this is the one
            # collection that would otherwise grow for the life of the file.
            "traded_mints": sorted(self.traded_mints)[-5000:],
        }
        write_atomic(self.path, payload)

    def load(self) -> None:
        if not self.path.exists():
            log.info("no state file at %s; starting clean", self.path)
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.error("state file unreadable (%s); starting clean", exc)
            return

        for raw in data.get("positions", []):
            try:
                position = Position.model_validate(raw)
            except Exception as exc:
                log.warning("dropping unreadable position record: %s", exc)
                continue
            self.positions[position.mint] = position

        self.traded_mints = set(data.get("traded_mints", []))

        # Positions always come back -- they are open regardless of when the
        # file was written. Daily counters come back only if the file is
        # from today, because yesterday's loss must not eat today's budget.
        saved_day = str(data.get("day", ""))
        today = utc_day()
        if saved_day == today:
            self.day = saved_day
            self.today_loss_sol = float(data.get("today_loss_sol", 0.0))
            self.today_profit_sol = float(data.get("today_profit_sol", 0.0))
            self.today_trades = int(data.get("today_trades", 0))
        else:
            log.info("state file is from %s, not %s; daily counters reset",
                     saved_day or "an unknown day", today)

        log.info(
            "restored %d open position(s), %d traded mints, %d trades today",
            len(self.positions), len(self.traded_mints), self.today_trades,
        )

    # -- syncing with the risk manager -------------------------------------

    def apply_to(self, risk: RiskManager) -> None:
        """Push restored counters into the risk manager."""
        risk.day = self.day
        risk.today_loss_sol = self.today_loss_sol
        risk.today_profit_sol = self.today_profit_sol
        risk.today_trades = self.today_trades
        risk.open_positions = len(self.positions)

    def capture(self, risk: RiskManager) -> None:
        """Pull current counters back out of the risk manager."""
        self.day = risk.day
        self.today_loss_sol = risk.today_loss_sol
        self.today_profit_sol = risk.today_profit_sol
        self.today_trades = risk.today_trades

    # -- positions ---------------------------------------------------------

    def add_position(self, position: Position) -> None:
        self.positions[position.mint] = position
        self.traded_mints.add(position.mint)

    def remove_position(self, mint: str) -> Position | None:
        return self.positions.pop(mint, None)

    def already_traded(self, mint: str) -> bool:
        return mint in self.traded_mints

    def creator_is_held(self, creator: str) -> bool:
        """True if an open position already belongs to this deployer."""
        if not creator:
            return False
        return any(p.creator == creator for p in self.positions.values())


def write_atomic(path: str | Path, payload: Any) -> None:
    """Serialise to a temp file in the target directory, then replace.

    Same directory matters: ``os.replace`` is only atomic within a
    filesystem, and /tmp is routinely a different one.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(
        dir=target.parent, prefix=f".{target.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, target)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp_name)
        raise
