"""Stage 1: the launch stream, and the cheap filter that guards it.

This is the widest and cheapest stage. pump.fun produces thousands of
tokens a day and most are dead on arrival; everything downstream costs
money, so the job here is to throw away the obvious noise without spending
a single model call on it.

The monitor owns its connection: it reconnects with backoff, it bounds
every collection it keeps, and it reports when the stream goes quiet
instead of blocking forever on a socket nothing is writing to.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import time
from collections import deque
from collections.abc import AsyncIterator, Callable
from typing import Any

from .models import FilterConfig, Token

log = logging.getLogger(__name__)

# Bounds. Nothing here is allowed to grow without limit in a process that
# is expected to run for weeks.
MAX_SEEN_MINTS = 50_000
MAX_BUFFER = 1_000

RECONNECT_BASE_DELAY = 1.0
RECONNECT_MAX_DELAY = 60.0

# If nothing arrives for this long the stream is treated as stalled and the
# connection is torn down and rebuilt. A silent socket looks identical to a
# quiet market from the inside, and waiting forever on either is wrong.
STALL_TIMEOUT_SECONDS = 180.0


class FilterVerdict:
    """Why a token was let through, or why it was not."""

    __slots__ = ("passed", "reason", "detail")

    def __init__(self, passed: bool, reason: str = "", detail: Any = None) -> None:
        self.passed = passed
        self.reason = reason
        self.detail = detail

    def __bool__(self) -> bool:
        return self.passed

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"FilterVerdict(passed={self.passed}, reason={self.reason!r})"


PASS = FilterVerdict(True)


def basic_filter(token: Token, config: FilterConfig) -> FilterVerdict:
    """The stream-level filter. Pure, cheap, and the reason it is first.

    Each rejection carries a reason so the log can later show *where* the
    stream is being lost, not merely that it was.
    """
    if not token.mint:
        return FilterVerdict(False, "no_mint")

    if config.require_metadata and not token.has_metadata:
        return FilterVerdict(False, "no_metadata")

    if token.unique_buyers < config.min_unique_buyers:
        return FilterVerdict(False, "too_few_buyers", token.unique_buyers)

    # Past this point on the curve most of the move has already happened
    # and the next buyer is closer to being exit liquidity than early.
    if token.bonding_curve_pct >= config.max_curve_pct:
        return FilterVerdict(False, "curve_too_advanced", token.bonding_curve_pct)

    # Tokens sniped by bots in the first seconds have not yet shown whether
    # anyone organic wants them. Surviving two minutes is a weak signal, but
    # it is the cheapest one available.
    if token.age_minutes < config.min_age_minutes:
        return FilterVerdict(False, "too_young", token.age_minutes)

    if token.risk_score > config.max_risk_score:
        return FilterVerdict(False, "high_risk", token.risk_score)

    return PASS


class WebSocketMonitor:
    """Subscribes to new launches and yields them as :class:`Token`.

    ``connect`` is injected rather than imported so tests can drive the
    monitor with a fake socket and never touch the network.
    """

    def __init__(
        self,
        ws_url: str,
        api_key: str = "",
        connect: Callable[..., Any] | None = None,
        stall_timeout: float = STALL_TIMEOUT_SECONDS,
    ) -> None:
        self.ws_url = ws_url
        self.api_key = api_key
        self.stall_timeout = stall_timeout
        self._connect = connect
        self._seen: deque[str] = deque(maxlen=MAX_SEEN_MINTS)
        self._seen_set: set[str] = set()
        self.last_message_at: float = 0.0
        self.messages_received = 0
        self.tokens_yielded = 0
        self.reconnects = 0

    # -- deduplication -----------------------------------------------------

    def is_new(self, mint: str) -> bool:
        """True the first time a mint is seen; False forever after.

        The deque and the set are kept in step so memory stays bounded:
        when the deque evicts its oldest mint, the set drops it too.
        """
        if mint in self._seen_set:
            return False
        if len(self._seen) == self._seen.maxlen:
            evicted = self._seen[0]
            self._seen_set.discard(evicted)
        self._seen.append(mint)
        self._seen_set.add(mint)
        return True

    @property
    def seen_count(self) -> int:
        return len(self._seen_set)

    # -- stream ------------------------------------------------------------

    def _subscribe_frame(self) -> str:
        return json.dumps({"method": "subscribeNewToken", "params": {"launchpad": "pumpfun"}})

    def _open(self) -> Any:
        if self._connect is None:  # pragma: no cover - exercised only live
            # Deferred so the dry-run path imports without the dependency.
            import websockets  # noqa: PLC0415

            headers = {"x-api-key": self.api_key} if self.api_key else {}
            return websockets.connect(self.ws_url, additional_headers=headers)
        return self._connect(self.ws_url)

    async def stream_launches(self) -> AsyncIterator[Token]:
        """Yield new tokens forever, reconnecting on failure.

        Backoff is exponential with jitter. Jitter matters because a
        provider outage otherwise has every client in the world retrying on
        exactly the same schedule.
        """
        delay = RECONNECT_BASE_DELAY
        while True:
            try:
                async with self._open() as socket:
                    await socket.send(self._subscribe_frame())
                    log.info("subscribed to launch stream at %s", self.ws_url)
                    delay = RECONNECT_BASE_DELAY
                    self.last_message_at = time.time()
                    async for token in self._read(socket):
                        yield token
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.reconnects += 1
                log.warning("launch stream dropped (%s); reconnecting in %.1fs", exc, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, RECONNECT_MAX_DELAY)
                delay *= 0.5 + random.random()  # noqa: S311 - jitter, not crypto

    async def _read(self, socket: Any) -> AsyncIterator[Token]:
        while True:
            try:
                raw = await asyncio.wait_for(socket.recv(), timeout=self.stall_timeout)
            except TimeoutError as exc:
                raise ConnectionError(
                    f"no frames for {self.stall_timeout:.0f}s; assuming stalled"
                ) from exc

            self.messages_received += 1
            self.last_message_at = time.time()

            token = self.parse(raw)
            if token is None:
                continue
            if not self.is_new(token.mint):
                continue
            self.tokens_yielded += 1
            yield token

    def parse(self, raw: str | bytes) -> Token | None:
        """Turn one frame into a Token, or None if it is not a launch.

        A frame that cannot be parsed is dropped with a log line rather
        than killing the stream: one malformed message from a provider
        should not end a run that has been up for days.
        """
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError, ValueError):
            log.debug("unparseable frame dropped")
            return None

        if not isinstance(data, dict):
            return None

        # Providers wrap the payload differently; unwrap the common shapes.
        for key in ("data", "token", "payload"):
            inner = data.get(key)
            if isinstance(inner, dict):
                merged = {**data, **inner}
                merged.pop(key, None)
                data = merged
                break

        kind = str(data.get("type") or data.get("event") or data.get("method") or "")
        if kind and kind.lower() not in {"newtoken", "new_token", "create", "subscribenewtoken"}:
            return None

        try:
            token = Token.from_ws(data)
        except Exception:
            log.debug("frame did not fit the token shape")
            return None

        return token if token.mint else None


class BoundedQueue:
    """A drop-oldest queue between the stream and the analysis stages.

    Analysis is slower than the stream and always will be. The choice is
    between blocking the socket, growing without limit, or dropping -- and
    dropping the oldest launch is right, because in this market the oldest
    unprocessed launch is also the most stale.
    """

    def __init__(self, maxsize: int = MAX_BUFFER) -> None:
        self._items: deque[Token] = deque(maxlen=maxsize)
        self._event = asyncio.Event()
        self.dropped = 0

    def put(self, token: Token) -> None:
        if len(self._items) == self._items.maxlen:
            self.dropped += 1
        self._items.append(token)
        self._event.set()

    async def get(self) -> Token:
        while not self._items:
            self._event.clear()
            await self._event.wait()
        return self._items.popleft()

    def __len__(self) -> int:
        return len(self._items)


async def drain(queue: BoundedQueue) -> list[Token]:
    """Everything currently buffered, without waiting. Used at shutdown."""
    items: list[Token] = []
    with contextlib.suppress(IndexError):
        while True:
            items.append(queue._items.popleft())
    return items
