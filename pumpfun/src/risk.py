"""Stage 8: the brakes, and the rules that close a position.

pump.fun is an environment where most tokens go to zero and the last buyer
on the curve is exit liquidity for the first. Nothing in this pipeline
changes that arithmetic. What risk management does is bound the rate at
which it can cost money -- it limits how fast you can lose, not whether
you lose.

Five limits gate entry. Four rules force an exit. Both sets are code.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime
from typing import NamedTuple

from .models import Position, RiskConfig

log = logging.getLogger(__name__)


class Decision(NamedTuple):
    """Whether a trade may proceed, and which limit stopped it."""

    allowed: bool
    reason: str = ""

    def __bool__(self) -> bool:
        return self.allowed


ALLOWED = Decision(True)


def utc_day(timestamp: float | None = None) -> str:
    moment = datetime.fromtimestamp(
        time.time() if timestamp is None else timestamp, tz=UTC
    )
    return moment.strftime("%Y-%m-%d")


class RiskManager:
    """Entry limits and daily accounting.

    Counters are attributes rather than derived values because they must
    survive a restart: a process that reset its daily loss on every restart
    would have no daily limit at all, only a per-uptime one.
    """

    def __init__(self, config: RiskConfig) -> None:
        self.config = config
        self.day = utc_day()
        self.today_loss_sol = 0.0
        self.today_profit_sol = 0.0
        self.today_trades = 0
        self.open_positions = 0

    # -- day boundary ------------------------------------------------------

    def roll_day_if_needed(self, timestamp: float | None = None) -> bool:
        """Reset the daily counters when the UTC day changes.

        Open positions are explicitly *not* reset: they are a live fact
        about the wallet, not a fact about today.
        """
        today = utc_day(timestamp)
        if today == self.day:
            return False
        log.info(
            "day rolled %s -> %s (loss %.4f SOL over %d trades)",
            self.day, today, self.today_loss_sol, self.today_trades,
        )
        self.day = today
        self.today_loss_sol = 0.0
        self.today_profit_sol = 0.0
        self.today_trades = 0
        return True

    # -- the five limits ---------------------------------------------------

    def can_trade(self, timestamp: float | None = None) -> Decision:
        self.roll_day_if_needed(timestamp)

        if self.today_loss_sol >= self.config.daily_loss_limit_sol:
            return Decision(False, "daily_loss_limit")
        if self.today_trades >= self.config.max_trades_per_day:
            return Decision(False, "daily_trade_limit")
        if self.open_positions >= self.config.max_open_positions:
            return Decision(False, "max_open_positions")
        if self.remaining_budget_sol() <= 0:
            return Decision(False, "daily_loss_limit")
        return ALLOWED

    def remaining_budget_sol(self) -> float:
        return max(0.0, self.config.daily_loss_limit_sol - self.today_loss_sol)

    def position_size(self, score: float) -> float:
        """Size proportional to conviction, bounded twice.

        The per-trade ceiling caps any one bet. The second bound -- 30% of
        what is left of the daily loss budget -- is what makes the last
        trades of a losing day small: without it, the final trade before
        the limit could be as large as the first.
        """
        clamped = max(0.0, min(1.0, score))
        base = self.config.max_sol_per_trade * clamped
        headroom = self.remaining_budget_sol() * 0.3
        return max(0.0, min(base, headroom))

    # -- accounting --------------------------------------------------------

    def record_open(self) -> None:
        self.roll_day_if_needed()
        self.open_positions += 1
        self.today_trades += 1

    def record_close(self, pnl_sol: float) -> None:
        """Book a closed position.

        ``open_positions`` floors at zero so a double-close -- a close
        racing a shutdown, say -- cannot drive the count negative and
        quietly hand the pipeline extra position slots.
        """
        self.open_positions = max(0, self.open_positions - 1)
        if pnl_sol < 0:
            self.today_loss_sol += abs(pnl_sol)
        else:
            self.today_profit_sol += pnl_sol

    @property
    def today_net_sol(self) -> float:
        return self.today_profit_sol - self.today_loss_sol


class Exit(NamedTuple):
    """A decision to close a position."""

    should_exit: bool
    reason: str = ""

    def __bool__(self) -> bool:
        return self.should_exit


HOLD = Exit(False)


def check_exit(
    position: Position,
    price: float,
    config: RiskConfig,
    now: float | None = None,
) -> Exit:
    """Apply the four exit rules in priority order.

    Order is priority: a position that has both broken its stop and run out
    of time exits as a stop, because that is the reason that matters.

    A zero in any threshold disables that rule -- which is why each is
    guarded rather than simply compared.
    """
    if price <= 0 or position.entry_price <= 0:
        # An unknown price is not a reason to sell, and cannot be evaluated
        # against any threshold. Hold and re-poll.
        return HOLD

    change_pct = position.pnl_pct(price)

    if config.stop_loss_pct > 0 and change_pct <= -config.stop_loss_pct:
        return Exit(True, "stop_loss")

    if config.take_profit_pct > 0 and change_pct >= config.take_profit_pct:
        return Exit(True, "take_profit")

    # Trailing only arms once the position has actually traded above entry.
    # Without that guard a position that only ever fell would trail from its
    # own entry price and exit at trailing_stop_pct -- silently overriding
    # the stop_loss_pct the operator configured, for every losing position.
    # Once the peak is genuinely above entry the rule stays armed even if
    # price falls back through entry: giving back a run-up is precisely what
    # it exists to prevent, and it fires sooner than the entry-based stop.
    if config.trailing_stop_pct > 0 and position.peak_price > position.entry_price:
        drop_from_peak = (position.peak_price - price) / position.peak_price * 100.0
        if drop_from_peak >= config.trailing_stop_pct:
            return Exit(True, "trailing_stop")

    if config.max_hold_seconds > 0:
        elapsed = (time.time() if now is None else now) - position.opened_at
        if elapsed >= config.max_hold_seconds:
            return Exit(True, "max_hold")

    return HOLD


def update_peak(position: Position, price: float) -> None:
    """Track the high-water mark the trailing stop measures from.

    Kept on the position so it persists: after a restart, a trailing stop
    that began measuring again from the current price would have silently
    given back the entire run-up.
    """
    if price > position.peak_price:
        position.peak_price = price
