"""Stage 8: five entry limits, four exit rules, and the day boundary."""

from __future__ import annotations

import time

import pytest

from src.models import Position, RiskConfig
from src.risk import RiskManager, check_exit, update_peak, utc_day


@pytest.fixture
def config() -> RiskConfig:
    return RiskConfig(
        max_sol_per_trade=0.05, daily_loss_limit_sol=0.5,
        max_trades_per_day=3, max_open_positions=2,
        stop_loss_pct=50.0, take_profit_pct=100.0,
        trailing_stop_pct=30.0, max_hold_seconds=3600.0,
    )


# -- the five limits -------------------------------------------------------


def test_fresh_manager_allows_trading(config):
    assert RiskManager(config).can_trade()


def test_daily_loss_limit_stops_trading(config):
    risk = RiskManager(config)
    risk.record_open()
    risk.record_close(-0.5)
    decision = risk.can_trade()
    assert not decision
    assert decision.reason == "daily_loss_limit"


def test_daily_trade_count_limit(config):
    risk = RiskManager(config)
    for _ in range(3):
        risk.record_open()
        risk.record_close(0.01)
    decision = risk.can_trade()
    assert not decision
    assert decision.reason == "daily_trade_limit"


def test_open_position_limit(config):
    risk = RiskManager(config)
    risk.record_open()
    risk.record_open()
    decision = risk.can_trade()
    assert not decision
    assert decision.reason == "max_open_positions"


def test_position_size_scales_with_score(config):
    risk = RiskManager(config)
    assert risk.position_size(1.0) == pytest.approx(0.05)
    assert risk.position_size(0.5) == pytest.approx(0.025)
    assert risk.position_size(0.0) == 0.0


def test_position_size_shrinks_as_the_daily_budget_is_spent(config):
    """The last trade of a losing day must be smaller than the first."""
    risk = RiskManager(config)
    full = risk.position_size(1.0)
    risk.record_open()
    risk.record_close(-0.45)
    assert risk.position_size(1.0) < full
    assert risk.position_size(1.0) == pytest.approx(0.05 * 0.3, abs=1e-9)


def test_score_above_one_cannot_inflate_size(config):
    assert RiskManager(config).position_size(5.0) == pytest.approx(0.05)


def test_profit_does_not_offset_the_loss_limit(config):
    """The daily limit bounds gross loss; a win must not buy back headroom."""
    risk = RiskManager(config)
    risk.record_open()
    risk.record_close(-0.3)
    risk.record_open()
    risk.record_close(+1.0)
    assert risk.today_loss_sol == pytest.approx(0.3)
    assert risk.remaining_budget_sol() == pytest.approx(0.2)


# -- accounting ------------------------------------------------------------


def test_double_close_cannot_drive_open_count_negative(config):
    risk = RiskManager(config)
    risk.record_open()
    risk.record_close(0.0)
    risk.record_close(0.0)
    assert risk.open_positions == 0


def test_day_roll_resets_counters_but_not_open_positions(config):
    risk = RiskManager(config)
    risk.record_open()
    risk.record_close(-0.4)
    risk.record_open()
    assert risk.open_positions == 1

    risk.day = "1999-01-01"
    assert risk.roll_day_if_needed()
    assert risk.today_loss_sol == 0.0
    assert risk.today_trades == 0
    assert risk.open_positions == 1, "an open position is not a fact about today"
    assert risk.day == utc_day()


def test_day_roll_is_idempotent_within_a_day(config):
    risk = RiskManager(config)
    assert not risk.roll_day_if_needed()


# -- the four exit rules ---------------------------------------------------


def position(**kwargs) -> Position:
    base = {
        "mint": "M", "entry_price": 1.0, "peak_price": 1.0,
        "opened_at": time.time(), "sol_spent": 0.05, "token_amount": 0.05,
    }
    base.update(kwargs)
    return Position(**base)


def test_stop_loss_fires_at_the_threshold(config):
    assert check_exit(position(), 0.5, config).reason == "stop_loss"
    assert not check_exit(position(), 0.51, config)


def test_take_profit_fires_at_the_threshold(config):
    assert check_exit(position(), 2.0, config).reason == "take_profit"
    assert not check_exit(position(), 1.99, config)


def test_trailing_stop_fires_after_a_run_up(config):
    pos = position()
    update_peak(pos, 2.0)
    # 2.0 -> 1.4 is exactly 30% off the peak.
    assert check_exit(pos, 1.4, config).reason == "trailing_stop"
    assert not check_exit(pos, 1.45, config)


def test_trailing_stop_stays_disarmed_until_price_exceeds_entry(config):
    """Otherwise trailing would silently override the configured stop-loss
    on every position that only ever fell."""
    pos = position()
    update_peak(pos, 0.99)
    assert pos.peak_price == 1.0
    assert not check_exit(pos, 0.7, config), "should be the stop-loss's decision, not trailing's"
    assert check_exit(pos, 0.49, config).reason == "stop_loss"


def test_max_hold_fires_on_a_position_that_never_moved(config):
    assert check_exit(position(opened_at=time.time() - 7200), 1.0, config).reason == "max_hold"


def test_stop_loss_wins_when_several_rules_fire_together(config):
    stale = position(opened_at=time.time() - 7200, peak_price=3.0)
    assert check_exit(stale, 0.2, config).reason == "stop_loss"


def test_zero_disables_an_individual_rule(config):
    no_tp = config.model_copy(update={"take_profit_pct": 0.0})
    assert not check_exit(position(), 5.0, no_tp)

    no_trail = config.model_copy(update={"trailing_stop_pct": 0.0})
    pos = position()
    update_peak(pos, 2.0)
    assert not check_exit(pos, 1.4, no_trail)


def test_config_rejects_disabling_every_exit_rule():
    with pytest.raises(ValueError, match="never close"):
        RiskConfig(stop_loss_pct=0, take_profit_pct=0,
                   trailing_stop_pct=0, max_hold_seconds=0)


def test_unknown_price_holds_rather_than_selling(config):
    assert not check_exit(position(), 0.0, config)
    assert not check_exit(position(entry_price=0.0), 1.0, config)


def test_peak_only_ever_rises(config):
    pos = position()
    update_peak(pos, 2.0)
    update_peak(pos, 1.0)
    assert pos.peak_price == 2.0
