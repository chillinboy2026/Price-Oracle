"""Stage 1: the cheap filter, frame parsing, dedupe, and the queue."""

from __future__ import annotations

import pytest

from src.models import FilterConfig, Token
from src.monitor import MAX_SEEN_MINTS, BoundedQueue, WebSocketMonitor, basic_filter


def make(**kwargs) -> Token:
    base = {
        "mint": "M" * 32, "name": "n", "image_url": "i",
        "unique_buyers": 10, "bonding_curve_pct": 10.0,
        "age_minutes": 5.0, "risk_score": 3.0,
    }
    base.update(kwargs)
    return Token(**base)


def test_healthy_token_passes():
    assert basic_filter(make(), FilterConfig())


@pytest.mark.parametrize(
    ("kwargs", "reason"),
    [
        ({"mint": ""}, "no_mint"),
        ({"name": "", "image_url": ""}, "no_metadata"),
        ({"unique_buyers": 2}, "too_few_buyers"),
        ({"bonding_curve_pct": 80.0}, "curve_too_advanced"),
        ({"age_minutes": 0.5}, "too_young"),
        ({"risk_score": 9.0}, "high_risk"),
    ],
)
def test_each_rule_rejects_with_its_reason(kwargs, reason):
    verdict = basic_filter(make(**kwargs), FilterConfig())
    assert not verdict
    assert verdict.reason == reason


def test_filter_boundaries_are_exclusive_at_the_threshold():
    config = FilterConfig(min_unique_buyers=5, max_curve_pct=40.0, min_age_minutes=2.0)
    assert basic_filter(make(unique_buyers=5, bonding_curve_pct=39.9, age_minutes=2.0), config)
    assert not basic_filter(make(bonding_curve_pct=40.0), config)
    assert not basic_filter(make(unique_buyers=4), config)


def test_metadata_requirement_can_be_disabled():
    naked = make(name="", image_url="")
    assert not basic_filter(naked, FilterConfig())
    assert basic_filter(naked, FilterConfig(require_metadata=False))


# -- frame parsing ---------------------------------------------------------


def test_parse_unwraps_nested_payload():
    monitor = WebSocketMonitor("wss://x")
    token = monitor.parse('{"type":"newToken","data":{"mint":"abc","name":"Cat","image":"i"}}')
    assert token is not None
    assert token.mint == "abc"
    assert token.name == "Cat"


def test_parse_accepts_provider_field_aliases():
    monitor = WebSocketMonitor("wss://x")
    token = monitor.parse('{"mint":"abc","tokenName":"Cat","image_uri":"i","holders":7}')
    assert token is not None
    assert token.name == "Cat"
    assert token.unique_buyers == 7


def test_malformed_frames_are_dropped_not_raised():
    monitor = WebSocketMonitor("wss://x")
    assert monitor.parse("not json") is None
    assert monitor.parse("[1,2,3]") is None
    assert monitor.parse('{"no":"mint"}') is None
    assert monitor.parse('{"type":"trade","mint":"abc"}') is None


def test_dedupe_is_first_seen_only():
    monitor = WebSocketMonitor("wss://x")
    assert monitor.is_new("a")
    assert not monitor.is_new("a")
    assert monitor.is_new("b")
    assert monitor.seen_count == 2


def test_dedupe_memory_stays_bounded():
    """The set must shrink with the deque, or it leaks for the process life."""
    monitor = WebSocketMonitor("wss://x")
    for index in range(MAX_SEEN_MINTS + 500):
        monitor.is_new(f"mint{index}")
    assert monitor.seen_count == MAX_SEEN_MINTS
    assert monitor.is_new("mint0"), "evicted mint should look new again"


# -- the queue -------------------------------------------------------------


async def test_queue_is_fifo():
    queue = BoundedQueue(maxsize=10)
    queue.put(make(mint="a"))
    queue.put(make(mint="b"))
    assert (await queue.get()).mint == "a"
    assert (await queue.get()).mint == "b"


async def test_queue_drops_oldest_when_full():
    queue = BoundedQueue(maxsize=2)
    for mint in ("a", "b", "c"):
        queue.put(make(mint=mint))
    assert queue.dropped == 1
    assert (await queue.get()).mint == "b"


async def test_queue_get_waits_for_an_item():
    import asyncio

    queue = BoundedQueue()
    task = asyncio.create_task(queue.get())
    await asyncio.sleep(0)
    assert not task.done()
    queue.put(make(mint="late"))
    assert (await task).mint == "late"
