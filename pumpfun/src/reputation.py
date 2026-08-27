"""Stage 1.5: memory of deployers.

The pipeline judges every launch from a clean slate, so without this the
same deployer could rug the same wallet three times and be a stranger each
time. The auditor cannot help: it sees one token, not an address's history.

What makes this book worth trusting is where it comes from. It is not a
list downloaded from somewhere and not a heuristic -- it is built from this
pipeline's *own closed trades*. A position that closed worse than
``rug_loss_pct`` is recorded against the address that deployed it.

Addresses that never rugged are forgotten after a while. Addresses that did
are never forgotten: they are the entire value of the file.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from .models import ReputationConfig
from .state import write_atomic

log = logging.getLogger(__name__)

DAY_SECONDS = 86_400.0


class CreatorBook:
    """Rug counts per deployer address, persisted across restarts."""

    def __init__(self, config: ReputationConfig) -> None:
        self.config = config
        self.path = Path(config.path)
        self.rugs: dict[str, int] = {}
        self.last_seen: dict[str, float] = {}
        self.trades: dict[str, int] = {}

    # -- persistence -------------------------------------------------------

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.error("creator book unreadable (%s); starting empty", exc)
            return
        self.rugs = {str(k): int(v) for k, v in data.get("rugs", {}).items()}
        self.last_seen = {str(k): float(v) for k, v in data.get("last_seen", {}).items()}
        self.trades = {str(k): int(v) for k, v in data.get("trades", {}).items()}
        self.forget_stale()
        log.info("creator book: %d addresses, %d with rugs",
                 len(self.last_seen), sum(1 for v in self.rugs.values() if v))

    def save(self) -> None:
        write_atomic(self.path, {
            "rugs": self.rugs,
            "last_seen": self.last_seen,
            "trades": self.trades,
        })

    # -- the gate ----------------------------------------------------------

    def is_blocked(self, creator: str) -> bool:
        """True once an address has rugged us enough times."""
        if not self.config.enabled or not creator:
            return False
        return self.rugs.get(creator, 0) >= self.config.block_creator_after_rugs

    def rug_count(self, creator: str) -> int:
        return self.rugs.get(creator, 0)

    # -- recording ---------------------------------------------------------

    def record_trade(self, creator: str) -> None:
        if not creator:
            return
        self.trades[creator] = self.trades.get(creator, 0) + 1
        self.last_seen[creator] = time.time()

    def record_close(self, creator: str, pnl_pct: float) -> bool:
        """Book a closed trade. Returns True if it counted as a rug."""
        if not creator:
            return False
        self.last_seen[creator] = time.time()
        if pnl_pct <= -self.config.rug_loss_pct:
            self.rugs[creator] = self.rugs.get(creator, 0) + 1
            log.warning(
                "creator %s... rugged us (%.0f%%): %d total",
                creator[:8], pnl_pct, self.rugs[creator],
            )
            return True
        return False

    # -- housekeeping ------------------------------------------------------

    def forget_stale(self, now: float | None = None) -> int:
        """Drop clean addresses not seen in a while. Rugs are kept forever."""
        if self.config.forget_creators_after_days <= 0:
            return 0
        cutoff = (time.time() if now is None else now) - (
            self.config.forget_creators_after_days * DAY_SECONDS
        )
        stale = [
            address for address, seen in self.last_seen.items()
            if seen < cutoff and not self.rugs.get(address)
        ]
        for address in stale:
            self.last_seen.pop(address, None)
            self.trades.pop(address, None)
        if stale:
            log.debug("forgot %d clean creator addresses", len(stale))
        return len(stale)

    def snapshot(self) -> dict[str, Any]:
        return {
            "addresses": len(self.last_seen),
            "rugged": sum(1 for v in self.rugs.values() if v),
            "blocked": sum(
                1 for v in self.rugs.values()
                if v >= self.config.block_creator_after_rugs
            ),
        }
