"""State across restart, and the atomic write that protects it."""

from __future__ import annotations

import json

from src.models import Position, RiskConfig
from src.risk import RiskManager, utc_day
from src.state import PipelineState, write_atomic


def test_positions_and_counters_survive_a_restart(tmp_path):
    path = tmp_path / "state.json"
    state = PipelineState(path)
    state.add_position(Position(mint="m1", creator="c1", entry_price=1.0, peak_price=2.5))
    state.today_loss_sol = 0.2
    state.today_trades = 3
    state.save()

    restored = PipelineState(path)
    restored.load()
    assert restored.positions["m1"].peak_price == 2.5, "peak must survive or trailing resets"
    assert restored.today_loss_sol == 0.2
    assert restored.today_trades == 3
    assert restored.already_traded("m1")


def test_a_stale_file_keeps_positions_but_drops_daily_counters(tmp_path):
    """Yesterday's loss must not eat today's budget; an open position is
    still open regardless of the date."""
    path = tmp_path / "state.json"
    write_atomic(path, {
        "day": "1999-01-01", "today_loss_sol": 9.0, "today_trades": 99,
        "positions": [{"mint": "m1", "entry_price": 1.0}], "traded_mints": ["m1"],
    })
    state = PipelineState(path)
    state.load()
    assert state.today_loss_sol == 0.0
    assert state.today_trades == 0
    assert "m1" in state.positions


def test_missing_file_starts_clean(tmp_path):
    state = PipelineState(tmp_path / "absent.json")
    state.load()
    assert state.positions == {}


def test_corrupt_file_starts_clean_instead_of_crashing(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{not json")
    state = PipelineState(path)
    state.load()
    assert state.positions == {}


def test_one_unreadable_position_does_not_discard_the_rest(tmp_path):
    path = tmp_path / "state.json"
    write_atomic(path, {
        "day": utc_day(),
        "positions": [{"mint": "good", "entry_price": 1.0}, {"nonsense": True}],
        "traded_mints": [],
    })
    state = PipelineState(path)
    state.load()
    assert list(state.positions) == ["good"]


def test_round_trip_with_the_risk_manager(tmp_path):
    risk = RiskManager(RiskConfig())
    risk.record_open()
    risk.record_close(-0.1)

    state = PipelineState(tmp_path / "s.json")
    state.add_position(Position(mint="m", entry_price=1.0))
    state.capture(risk)
    state.save()

    restored = PipelineState(tmp_path / "s.json")
    restored.load()
    fresh = RiskManager(RiskConfig())
    restored.apply_to(fresh)
    assert fresh.today_loss_sol == 0.1
    assert fresh.open_positions == 1


def test_creator_and_mint_memory(tmp_path):
    state = PipelineState(tmp_path / "s.json")
    state.add_position(Position(mint="m", creator="dev", entry_price=1.0))
    assert state.creator_is_held("dev")
    assert not state.creator_is_held("other")
    assert not state.creator_is_held("")

    state.remove_position("m")
    assert not state.creator_is_held("dev")
    assert state.already_traded("m"), "a closed mint is still a traded mint"


def test_atomic_write_leaves_no_temp_files(tmp_path):
    path = tmp_path / "s.json"
    for index in range(5):
        write_atomic(path, {"n": index})
    assert json.loads(path.read_text())["n"] == 4
    assert list(tmp_path.iterdir()) == [path]


def test_traded_mints_are_bounded(tmp_path):
    state = PipelineState(tmp_path / "s.json")
    state.traded_mints = {f"m{i}" for i in range(6000)}
    state.save()
    restored = PipelineState(tmp_path / "s.json")
    restored.load()
    assert len(restored.traded_mints) == 5000
