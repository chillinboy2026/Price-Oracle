"""Spend limiters, metrics, and the health endpoint."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from src.models import OpsConfig
from src.ops import CallLimiter, CircuitBreaker, DailyBudget, HealthServer, Metrics, TokenBucket

# -- rate limiting ---------------------------------------------------------


def test_bucket_allows_a_burst_then_refuses():
    bucket = TokenBucket(per_minute=3)
    assert sum(bucket.take(now=0.0) for _ in range(10)) == 3


def test_bucket_refills_over_time():
    bucket = TokenBucket(per_minute=60)
    while bucket.take(now=0.0):
        pass
    assert bucket.take(now=2.0), "two seconds at 60/min should refill"


def test_zero_disables_the_rate_limit():
    bucket = TokenBucket(per_minute=0)
    assert all(bucket.take(now=0.0) for _ in range(1000))


# -- budget ----------------------------------------------------------------


def test_budget_stops_at_the_limit():
    budget = DailyBudget(3)
    assert sum(budget.take() for _ in range(10)) == 3
    assert budget.remaining == 0


def test_budget_resets_on_a_new_day():
    budget = DailyBudget(1)
    budget.take()
    budget.day = "1999-01-01"
    assert budget.take()


def test_zero_disables_the_budget():
    budget = DailyBudget(0)
    assert all(budget.take() for _ in range(1000))
    assert budget.remaining == -1


# -- breaker ---------------------------------------------------------------


def test_breaker_opens_only_on_consecutive_failures():
    breaker = CircuitBreaker(threshold=3, cooldown_seconds=60)
    breaker.record_failure()
    breaker.record_failure()
    breaker.record_success()
    breaker.record_failure()
    breaker.record_failure()
    assert not breaker.is_open, "a success in between resets the run"
    breaker.record_failure()
    assert breaker.is_open


def test_breaker_closes_after_its_cooldown():
    breaker = CircuitBreaker(threshold=1, cooldown_seconds=60)
    breaker.record_failure()
    assert breaker.is_open
    breaker.opened_at -= 61
    assert not breaker.is_open
    assert breaker.consecutive_failures == 0


def test_breaker_counts_its_trips():
    breaker = CircuitBreaker(threshold=1, cooldown_seconds=0.01)
    breaker.record_failure()
    breaker.opened_at -= 1
    assert not breaker.is_open
    breaker.record_failure()
    assert breaker.trips == 2


# -- the combined limiter --------------------------------------------------


async def test_an_open_breaker_refuses_calls():
    limiter = CallLimiter(OpsConfig(breaker_failures=1, breaker_cooldown_seconds=60))
    limiter.record_failure()
    assert not await limiter.acquire()
    assert limiter.snapshot()["refused"]["breaker_open"] == 1


async def test_an_exhausted_budget_refuses_calls():
    limiter = CallLimiter(OpsConfig(grok_daily_call_budget=1))
    assert await limiter.acquire()
    assert not await limiter.acquire()
    assert limiter.snapshot()["refused"]["daily_budget"] == 1


async def test_the_snapshot_reports_what_is_left():
    limiter = CallLimiter(OpsConfig(grok_daily_call_budget=10))
    await limiter.acquire()
    snapshot = limiter.snapshot()
    assert snapshot["grok_calls_used_today"] == 1
    assert snapshot["grok_calls_remaining"] == 9
    assert not snapshot["breaker_open"]


# -- metrics ---------------------------------------------------------------


def test_prometheus_rendering_is_well_formed():
    metrics = Metrics()
    metrics.inc("tokens_seen", 3)
    metrics.set("open_positions", 2)
    text = metrics.render_prometheus()
    assert "pumpbot_tokens_seen_total 3" in text
    assert "pumpbot_open_positions 2" in text
    assert text.endswith("\n")


def test_metric_names_are_sanitised():
    metrics = Metrics()
    metrics.inc("skip:too-young")
    assert "pumpbot_skip_too_young_total 1" in metrics.render_prometheus()


# -- health endpoint -------------------------------------------------------


@pytest.fixture
def status_ok():
    return lambda: {
        "healthy": True,
        "health": {"status": "ok", "open_positions": 0},
        "metrics_text": "pumpbot_up 1\n",
    }


async def serve(status):
    server = HealthServer(0, status)
    # Bind an ephemeral port by starting manually.
    server._server = await asyncio.start_server(server._handle, "127.0.0.1", 0)
    port = server._server.sockets[0].getsockname()[1]
    return server, port


async def test_healthz_returns_200_when_ok(status_ok):
    server, port = await serve(status_ok)
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"http://127.0.0.1:{port}/healthz")
        assert response.status_code == 200
        assert json.loads(response.text)["status"] == "ok"
    finally:
        await server.stop()


async def test_healthz_returns_503_when_degraded():
    def degraded():
        return {"healthy": False, "health": {"status": "degraded"}, "metrics_text": ""}

    server, port = await serve(degraded)
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"http://127.0.0.1:{port}/healthz")
        assert response.status_code == 503, "so a supervisor can restart on it"
    finally:
        await server.stop()


async def test_metrics_endpoint_serves_the_render(status_ok):
    server, port = await serve(status_ok)
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"http://127.0.0.1:{port}/metrics")
        assert response.status_code == 200
        assert "pumpbot_up 1" in response.text
    finally:
        await server.stop()


async def test_unknown_paths_404(status_ok):
    server, port = await serve(status_ok)
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"http://127.0.0.1:{port}/nope")
        assert response.status_code == 404
    finally:
        await server.stop()


async def test_port_zero_starts_nothing(status_ok):
    server = HealthServer(0, status_ok)
    await server.start()
    assert server._server is None
    await server.stop()
