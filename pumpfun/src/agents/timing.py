"""Agent 3: the market backdrop.

The narrative agent asks "is this token good?". This one asks "is now a
moment to buy anything?". They are different questions and a single agent
answering both would blur them.

Its answer is the same for every token inside a time window, so it is
cached. Without the cache each launch would pay for an identical verdict.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from ..models import TimingResult
from .base import JSON_ONLY, Agent

PROMPT = """You are judging the MOMENT for buying Solana memecoins, not any
one token.

- SOL 24h: {sol_24h_change}%
- BTC dominance: {btc_dominance}%
- pump.fun volume, 4h: {pf_volume_4h} SOL
- Graduations, 4h: {graduations_4h}
- Average volume per launch: {avg_volume_per_launch} SOL
- Hour (UTC): {hour_utc}

Rate 0.0-1.0:
1. market_mood: 0 is panic, 1 is greed
2. meme_season: is money rotating into memecoins or out of them
3. volume_signal: is pump.fun volume normal for this hour, or anomalous
4. timing_score: overall, is this an hour to be entering at all

{{"market_mood": 0.0, "meme_season": 0.0, "volume_signal": 0.0,
  "timing_score": 0.0, "notes": ""}}

""" + JSON_ONLY

CONTEXT_FIELDS = (
    "sol_24h_change",
    "btc_dominance",
    "pf_volume_4h",
    "graduations_4h",
    "avg_volume_per_launch",
    "hour_utc",
)


class MarketTimingAgent(Agent[TimingResult]):
    """Cached, single-flight market-regime verdict."""

    name = "timing"
    schema = TimingResult

    def __init__(self, client: Any, model: str, cache_seconds: float = 900.0) -> None:
        super().__init__(client, model)
        self.cache_seconds = cache_seconds
        self._cached: TimingResult | None = None
        self._cached_at = 0.0
        self._lock = asyncio.Lock()
        self.cache_hits = 0
        self.cache_misses = 0

    def build_prompt(self, context: dict[str, Any]) -> str:  # type: ignore[override]
        filled = {field: context.get(field, "unknown") for field in CONTEXT_FIELDS}
        return PROMPT.format(**filled)

    def _fresh(self) -> bool:
        return (
            self._cached is not None
            and (time.time() - self._cached_at) < self.cache_seconds
        )

    async def evaluate(self, context: dict[str, Any]) -> TimingResult:
        """Return the cached verdict, or compute one under a lock.

        The lock makes this single-flight: a burst of twenty launches
        arriving together produces one call, not twenty identical ones. The
        cache is re-checked inside the lock because the caller that was
        waiting on it usually finds the answer already computed.

        A failure is deliberately not cached -- a pessimistic verdict must
        not be pinned in place for the whole window when the next call
        might succeed.
        """
        if self._fresh():
            self.cache_hits += 1
            assert self._cached is not None
            return self._cached

        async with self._lock:
            if self._fresh():
                self.cache_hits += 1
                assert self._cached is not None
                return self._cached

            self.cache_misses += 1
            result = await self.run(context)
            if not result.notes.startswith(("call failed", "unparseable", "reply did not")):
                self._cached = result
                self._cached_at = time.time()
            return result
