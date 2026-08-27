"""The creator book: built from our own closed trades."""

from __future__ import annotations

import time

import pytest

from src.models import ReputationConfig
from src.reputation import CreatorBook


@pytest.fixture
def book(tmp_path) -> CreatorBook:
    return CreatorBook(ReputationConfig(
        path=str(tmp_path / "creators.json"),
        rug_loss_pct=60.0, block_creator_after_rugs=2,
        forget_creators_after_days=30.0,
    ))


def test_a_bad_close_counts_as_a_rug(book):
    assert book.record_close("dev", -80.0)
    assert book.rug_count("dev") == 1


def test_an_ordinary_loss_is_not_a_rug(book):
    assert not book.record_close("dev", -30.0)
    assert book.rug_count("dev") == 0


def test_blocking_takes_the_configured_number_of_rugs(book):
    book.record_close("dev", -90.0)
    assert not book.is_blocked("dev")
    book.record_close("dev", -90.0)
    assert book.is_blocked("dev")


def test_unknown_and_empty_addresses_are_never_blocked(book):
    assert not book.is_blocked("stranger")
    assert not book.is_blocked("")


def test_disabling_reputation_blocks_nobody(tmp_path):
    book = CreatorBook(ReputationConfig(
        enabled=False, path=str(tmp_path / "c.json"), block_creator_after_rugs=1))
    book.record_close("dev", -99.0)
    assert not book.is_blocked("dev")


def test_the_book_survives_a_restart(book, tmp_path):
    book.record_close("dev", -99.0)
    book.record_close("dev", -99.0)
    book.save()

    reloaded = CreatorBook(book.config)
    reloaded.load()
    assert reloaded.is_blocked("dev")


def test_clean_addresses_expire_but_ruggers_never_do(book):
    book.record_trade("clean")
    book.record_close("rugger", -99.0)
    book.last_seen["clean"] = time.time() - 40 * 86400
    book.last_seen["rugger"] = time.time() - 400 * 86400

    assert book.forget_stale() == 1
    assert "clean" not in book.last_seen
    assert book.rug_count("rugger") == 1, "the rugs are the whole value of the file"


def test_expiry_can_be_disabled(tmp_path):
    book = CreatorBook(ReputationConfig(
        path=str(tmp_path / "c.json"), forget_creators_after_days=0))
    book.record_trade("clean")
    book.last_seen["clean"] = 0.0
    assert book.forget_stale() == 0


def test_corrupt_book_starts_empty(book):
    book.path.parent.mkdir(parents=True, exist_ok=True)
    book.path.write_text("{oops")
    book.load()
    assert book.rugs == {}


def test_snapshot_counts_what_it_says(book):
    book.record_close("a", -99.0)
    book.record_close("b", -99.0)
    book.record_close("b", -99.0)
    book.record_trade("c")
    assert book.snapshot() == {"addresses": 3, "rugged": 2, "blocked": 1}
