"""Spend limiters, metrics, and liveness.

Model spend fails in three different ways, so it is bounded in three
different ways:

* a **token bucket** stops the pipeline calling faster than agreed;
* a **daily budget** stops a burst of launches eating a month of credit in
  one evening;
* a **circuit breaker** stops calling an endpoint that is not answering.

While the breaker is open every agent returns its pessimistic result --
which means the pipeline does not buy. That is the correct failure
direction: no signal is a reason to stand still, not to guess.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import Counter
from typing import Any

from .models import OpsConfig
from .risk import utc_day

log = logging.getLogger(__name__)


class TokenBucket:
    """Classic bucket: ``rate`` tokens per minute, refilled continuously."""

    def __init__(self, per_minute: int) -> None:
        self.per_minute = per_minute
        self.capacity = float(max(1, per_minute))
        self.tokens = self.capacity
        self.updated = time.monotonic()

    def take(self, now: float | None = None) -> bool:
        if self.per_minute <= 0:  # 0 disables the limit
            return True
        current = time.monotonic() if now is None else now
        elapsed = max(0.0, current - self.updated)
        self.updated = current
        self.tokens = min(self.capacity, self.tokens + elapsed * (self.per_minute / 60.0))
        if self.tokens >= 1.0:
            self.tokens -= 1.0
            return True
        return False


class DailyBudget:
    """A cap on calls per UTC day."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.day = utc_day()
        self.used = 0

    def take(self) -> bool:
        today = utc_day()
        if today != self.day:
            self.day = today
            self.used = 0
        if self.limit <= 0:  # 0 disables the limit
            return True
        if self.used >= self.limit:
            return False
        self.used += 1
        return True

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used) if self.limit > 0 else -1


class CircuitBreaker:
    """Opens after N consecutive failures, closes after a cooldown."""

    def __init__(self, threshold: int, cooldown_seconds: float) -> None:
        self.threshold = threshold
        self.cooldown = cooldown_seconds
        self.consecutive_failures = 0
        self.opened_at = 0.0
        self.trips = 0

    @property
    def is_open(self) -> bool:
        if self.opened_at == 0.0:
            return False
        if time.time() - self.opened_at >= self.cooldown:
            # Cooldown elapsed: close and let one call through to probe.
            # A single success resets the counter; a failure re-opens.
            self.opened_at = 0.0
            self.consecutive_failures = 0
            log.info("circuit breaker closed after cooldown")
            return False
        return True

    def record_success(self) -> None:
        self.consecutive_failures = 0

    def record_failure(self) -> None:
        self.consecutive_failures += 1
        if self.consecutive_failures >= self.threshold and self.opened_at == 0.0:
            self.opened_at = time.time()
            self.trips += 1
            log.error(
                "circuit breaker opened after %d consecutive failures; "
                "agents will return pessimistic results for %.0fs",
                self.consecutive_failures, self.cooldown,
            )


class CallLimiter:
    """The three limits behind one interface, as agents expect it."""

    def __init__(self, config: OpsConfig) -> None:
        self.bucket = TokenBucket(config.grok_rate_limit_per_minute)
        self.budget = DailyBudget(config.grok_daily_call_budget)
        self.breaker = CircuitBreaker(config.breaker_failures, config.breaker_cooldown_seconds)
        self.refused = Counter[str]()

    async def acquire(self) -> bool:
        if self.breaker.is_open:
            self.refused["breaker_open"] += 1
            return False
        if not self.budget.take():
            self.refused["daily_budget"] += 1
            return False
        # The bucket is checked last and waited on rather than refused:
        # a rate cap means "not yet", unlike a budget which means "not at
        # all today". Waiting is bounded by the caller's own timeout.
        for _ in range(50):
            if self.bucket.take():
                return True
            await asyncio.sleep(0.2)
        self.refused["rate_limit"] += 1
        return False

    def record_success(self) -> None:
        self.breaker.record_success()

    def record_failure(self) -> None:
        self.breaker.record_failure()

    def snapshot(self) -> dict[str, Any]:
        return {
            "grok_calls_used_today": self.budget.used,
            "grok_calls_remaining": self.budget.remaining,
            "breaker_open": self.breaker.is_open,
            "breaker_trips": self.breaker.trips,
            "consecutive_failures": self.breaker.consecutive_failures,
            "refused": dict(self.refused),
        }


class Metrics:
    """Plain counters and gauges. No dependency, no registry."""

    def __init__(self) -> None:
        self.counters = Counter[str]()
        self.gauges: dict[str, float] = {}
        self.started_at = time.time()

    def inc(self, name: str, amount: int = 1) -> None:
        self.counters[name] += amount

    def set(self, name: str, value: float) -> None:
        self.gauges[name] = value

    @property
    def uptime_seconds(self) -> float:
        return time.time() - self.started_at

    def render_prometheus(self) -> str:
        lines = [
            "# HELP pumpbot_uptime_seconds Process uptime.",
            "# TYPE pumpbot_uptime_seconds gauge",
            f"pumpbot_uptime_seconds {self.uptime_seconds:.1f}",
        ]
        for name, value in sorted(self.counters.items()):
            metric = f"pumpbot_{_safe(name)}_total"
            lines += [f"# TYPE {metric} counter", f"{metric} {value}"]
        for name, gauge in sorted(self.gauges.items()):
            metric = f"pumpbot_{_safe(name)}"
            lines += [f"# TYPE {metric} gauge", f"{metric} {gauge}"]
        return "\n".join(lines) + "\n"

    def snapshot(self) -> dict[str, Any]:
        return {
            "uptime_seconds": round(self.uptime_seconds, 1),
            "counters": dict(self.counters),
            "gauges": dict(self.gauges),
        }


def _safe(name: str) -> str:
    return "".join(char if char.isalnum() else "_" for char in name).strip("_").lower()


class HealthServer:
    """``GET /healthz`` and ``GET /metrics`` on raw asyncio.

    Two endpoints do not justify a web framework. ``/healthz`` returns 503
    when degraded so a supervisor can be pointed straight at it.
    """

    def __init__(self, port: int, status: Any) -> None:
        self.port = port
        self.status = status
        self._server: asyncio.AbstractServer | None = None

    async def start(self) -> None:
        if self.port <= 0:
            return
        self._server = await asyncio.start_server(self._handle, "0.0.0.0", self.port)  # noqa: S104
        log.info("health endpoint on :%d (/healthz, /metrics)", self.port)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    async def _handle(self, reader: asyncio.StreamReader,
                      writer: asyncio.StreamWriter) -> None:
        try:
            request = await asyncio.wait_for(reader.readline(), timeout=5.0)
            path = request.decode("latin-1").split(" ")[1] if b" " in request else "/"

            if path.startswith("/metrics"):
                body = self.status().get("metrics_text", "")
                await self._respond(writer, 200, body, "text/plain; version=0.0.4")
            elif path.startswith("/healthz"):
                payload = self.status()
                healthy = bool(payload.get("healthy", True))
                body = json.dumps(payload.get("health", payload), indent=2, default=str)
                await self._respond(writer, 200 if healthy else 503, body, "application/json")
            else:
                await self._respond(writer, 404, "not found\n", "text/plain")
        except (TimeoutError, ConnectionError, IndexError, UnicodeDecodeError):
            pass
        except Exception as exc:  # pragma: no cover - defensive
            log.debug("health request failed: %s", exc)
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except (ConnectionError, RuntimeError):
                pass

    async def _respond(self, writer: asyncio.StreamWriter, status: int,
                       body: str, content_type: str) -> None:
        reason = {200: "OK", 404: "Not Found", 503: "Service Unavailable"}.get(status, "OK")
        encoded = body.encode("utf-8")
        header = (
            f"HTTP/1.1 {status} {reason}\r\n"
            f"Content-Type: {content_type}\r\n"
            f"Content-Length: {len(encoded)}\r\n"
            "Connection: close\r\n\r\n"
        )
        writer.write(header.encode("latin-1") + encoded)
        await writer.drain()
