"""The JSONL decision log."""

from __future__ import annotations

import json

from src.log import TradeLog, read_records
from src.models import (
    AuditResult,
    CheckerResult,
    NarrativeResult,
    Position,
    ScoreBreakdown,
    TimingResult,
)


def test_a_buy_record_keeps_the_whole_decision(tmp_path, token, analysis):
    path = tmp_path / "trades.jsonl"
    log = TradeLog(path)
    position = Position(mint=token.mint, entry_price=1e-8, sol_spent=0.05,
                        token_amount=5e6, tx_hash="sig")
    score = ScoreBreakdown(audit=0.8, narrative=0.7, timing=0.6, metrics=0.75, total=0.73)

    log.buy(token, position, score, analysis, AuditResult(), NarrativeResult(),
            TimingResult(), CheckerResult(approve=True), "dry-run")

    record = json.loads(path.read_text().strip())
    assert record["action"] == "buy"
    # Components stored individually is what makes retuning possible later.
    assert record["components"] == {"audit": 0.8, "narrative": 0.7,
                                    "timing": 0.6, "metrics": 0.75}
    assert set(record) >= {"audit", "narrative", "timing", "checker", "metrics", "tx_hash"}


def test_a_skip_record_names_the_stage_and_reason(tmp_path, token):
    path = tmp_path / "t.jsonl"
    TradeLog(path).skip(token, "filter", "too_young", 0.5)
    record = json.loads(path.read_text().strip())
    assert record["stage"] == "filter"
    assert record["reason"] == "too_young"
    assert record["detail"] == 0.5


def test_a_scored_skip_records_the_weakest_component(tmp_path, token):
    path = tmp_path / "t.jsonl"
    score = ScoreBreakdown(audit=0.9, narrative=0.1, timing=0.8, metrics=0.7, total=0.6)
    TradeLog(path).skip(token, "scoring", "low_score", None, score)
    assert json.loads(path.read_text().strip())["weakest"] == "narrative"


def test_a_close_record_carries_pnl_and_reason(tmp_path):
    path = tmp_path / "t.jsonl"
    position = Position(mint="m", entry_price=1.0, sol_spent=0.1, token_amount=0.1)
    TradeLog(path).close(position, 0.5, -0.05, -50.0, "stop_loss", "sig")
    record = json.loads(path.read_text().strip())
    assert record["reason"] == "stop_loss"
    assert record["pnl_sol"] == -0.05
    assert record["pnl_pct"] == -50.0


def test_records_append_one_per_line(tmp_path, token):
    path = tmp_path / "t.jsonl"
    log = TradeLog(path)
    for index in range(5):
        log.skip(token, "filter", f"reason{index}")
    assert len(path.read_text().strip().splitlines()) == 5
    assert log.counts["skip"] == 5


def test_rotation_keeps_the_configured_backups(tmp_path, token):
    path = tmp_path / "t.jsonl"
    log = TradeLog(path, max_bytes=400, backups=2)
    for _ in range(60):
        log.skip(token, "filter", "padding-to-force-rotation")

    assert path.exists()
    assert path.with_suffix(".jsonl.1").exists()
    assert not path.with_suffix(".jsonl.3").exists(), "backups beyond the limit"


def test_reader_skips_corrupt_lines(tmp_path):
    path = tmp_path / "t.jsonl"
    path.write_text('{"action":"buy"}\nnot json\n\n{"action":"close"}\n{"trunc')
    actions = [record["action"] for record in read_records(path)]
    assert actions == ["buy", "close"]


def test_reader_on_a_missing_file_yields_nothing(tmp_path):
    assert list(read_records(tmp_path / "absent.jsonl")) == []


def test_log_directory_is_created(tmp_path, token):
    path = tmp_path / "deep" / "nested" / "t.jsonl"
    TradeLog(path).skip(token, "filter", "x")
    assert path.exists()
