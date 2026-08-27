"""The analysis scripts, driven over a synthetic log."""

from __future__ import annotations

import json

import pytest

from scripts import dashboard, replay, tune


def write_log(path, records) -> str:
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n")
    return str(path)


def buy(mint, score=0.7, **components):
    base = {"audit": 0.8, "narrative": 0.7, "timing": 0.6, "metrics": 0.7}
    base.update(components)
    return {
        "timestamp": "2026-08-27T12:00:00+00:00", "action": "buy", "token": mint,
        "symbol": mint[:4].upper(), "score": score, "components": base,
        "amount_sol": 0.05,
    }


def close(mint, pnl_sol, pnl_pct, reason="stop_loss"):
    return {
        "timestamp": "2026-08-27T12:30:00+00:00", "action": "close", "token": mint,
        "symbol": mint[:4].upper(), "pnl_sol": pnl_sol, "pnl_pct": pnl_pct,
        "reason": reason, "hold_seconds": 1800,
    }


def skip(reason, stage="filter"):
    return {"timestamp": "2026-08-27T11:00:00+00:00", "action": "skip",
            "token": "x", "stage": stage, "reason": reason}


@pytest.fixture
def log(tmp_path):
    records = [skip("too_young") for _ in range(20)]
    records += [skip("low_score", "scoring") for _ in range(5)]
    records += [buy("aaa", 0.72), close("aaa", -0.03, -60.0)]
    records += [buy("bbb", 0.81), close("bbb", 0.09, 180.0, "take_profit")]
    return write_log(tmp_path / "trades.jsonl", records)


def test_replay_summarises_the_funnel_and_pnl(log, capsys):
    assert replay.main([log]) == 0
    out = capsys.readouterr().out
    assert "considered" in out
    assert "too_young" in out
    assert "win rate" in out
    assert "take_profit" in out


def test_replay_warns_on_a_small_sample(log, capsys):
    replay.main([log])
    assert "too few to conclude" in capsys.readouterr().out


def test_replay_handles_an_empty_log(tmp_path, capsys):
    empty = write_log(tmp_path / "e.jsonl", [])
    assert replay.main([empty]) == 1


def test_tune_reranks_without_calling_any_agent(log, capsys):
    assert tune.main([log]) == 0
    out = capsys.readouterr().out
    assert "threshold sweep" in out
    assert "weight sets" in out


def test_tune_states_its_own_limitation(log, capsys):
    tune.main([log])
    out = capsys.readouterr().out
    assert "rejected ones" in out
    assert "curve-fitting" in out or "curve-fitting to noise" in out


def test_tune_needs_closed_trades(tmp_path):
    only_buys = write_log(tmp_path / "b.jsonl", [buy("aaa")])
    assert tune.main([only_buys]) == 1


def test_dashboard_renders_without_a_state_file(log, tmp_path, capsys):
    assert dashboard.main([log, "--state", str(tmp_path / "absent.json")]) == 0
    assert "no state file" in capsys.readouterr().out


def test_dashboard_shows_open_positions(log, tmp_path, capsys):
    import time

    state = tmp_path / "state.json"
    state.write_text(json.dumps({
        "positions": [{"mint": "aaa", "symbol": "AAA", "sol_spent": 0.05,
                       "entry_price": 1e-8, "peak_price": 2e-8,
                       "opened_at": time.time() - 600}],
        "today_trades": 2, "today_loss_sol": 0.03,
    }))
    assert dashboard.main([log, "--state", str(state)]) == 0
    out = capsys.readouterr().out
    assert "open positions: 1" in out
    assert "AAA" in out


def test_dashboard_survives_a_corrupt_state_file(log, tmp_path, capsys):
    state = tmp_path / "state.json"
    state.write_text("{broken")
    assert dashboard.main([log, "--state", str(state)]) == 0
