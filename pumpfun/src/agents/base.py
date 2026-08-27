"""Shared mechanics for every Grok call.

One rule governs this module, and it is the reason the mechanics are
shared rather than repeated per agent:

    **A failed check is a rejection, never a silent pass.**

A timeout, a 500, malformed JSON, a reply that does not fit the schema --
each of these returns the *pessimistic* value for that agent, not an empty
one and not a neutral one. The pipeline must never buy because a check
could not be run.

Note also what is *not* here: no agent returns a buy decision. Each returns
scores, and code decides. That separation is what keeps a persuasive model
reply from being able to move money on its own.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any, Generic, Protocol, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

RETRY_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}
BACKOFF_BASE = 0.5
BACKOFF_MAX = 8.0


class Limiter(Protocol):
    """What ``ops`` supplies to hold spending down.

    Kept as a protocol so the agents do not depend on the ops module and
    tests can pass a stub -- or nothing at all.
    """

    async def acquire(self) -> bool: ...
    def record_success(self) -> None: ...
    def record_failure(self) -> None: ...


class GrokError(Exception):
    """Any failure to obtain a usable reply."""


class GrokClient:
    """Thin wrapper over the xAI chat-completions endpoint."""

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.x.ai/v1",
        timeout: float = 30.0,
        max_retries: int = 3,
        client: httpx.AsyncClient | None = None,
        limiter: Limiter | None = None,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.timeout = timeout
        self.max_retries = max_retries
        self.limiter = limiter
        self._client = client
        self._owns_client = client is None
        self.calls_made = 0
        self.calls_failed = 0

    async def __aenter__(self) -> GrokClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=self.timeout,
            )
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def complete(self, model: str, prompt: str) -> str:
        """One completion, with retries. Raises :class:`GrokError`.

        ``temperature=0`` throughout: these are classification calls whose
        answers feed a numeric matrix, and a different answer each time for
        the same token would make the log worthless for tuning.
        """
        if self._client is None:
            raise GrokError("client used outside its context manager")

        if self.limiter is not None and not await self.limiter.acquire():
            raise GrokError("call refused by limiter (budget, rate cap, or open breaker)")

        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
        }

        last: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                self.calls_made += 1
                response = await self._client.post("/chat/completions", json=payload)
                if response.status_code in RETRY_STATUS:
                    raise GrokError(f"HTTP {response.status_code}")
                response.raise_for_status()
                text = _extract_text(response.json())
                if not text:
                    raise GrokError("empty completion")
                if self.limiter is not None:
                    self.limiter.record_success()
                return text
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                last = exc
                self.calls_failed += 1
                if attempt >= self.max_retries:
                    break
                delay = min(BACKOFF_BASE * 2**attempt, BACKOFF_MAX)
                delay *= 0.5 + random.random()  # noqa: S311 - jitter, not crypto
                log.debug("grok call failed (%s); retry %d in %.2fs", exc, attempt + 1, delay)
                await asyncio.sleep(delay)

        if self.limiter is not None:
            self.limiter.record_failure()
        raise GrokError(f"grok call failed after {self.max_retries + 1} attempts: {last}")


def _extract_text(body: Any) -> str:
    try:
        return str(body["choices"][0]["message"]["content"]).strip()
    except (KeyError, IndexError, TypeError):
        return ""


def parse_json_object(text: str) -> dict[str, Any]:
    """Pull the first balanced JSON object out of a model reply.

    Models wrap JSON in prose or fences however they feel like on the day.
    Scanning for a balanced object handles every variant, and -- unlike
    stripping characters off the ends -- it cannot corrupt the payload
    itself. String contents are tracked so a brace inside a quoted value
    does not end the scan early.
    """
    if not text:
        raise ValueError("empty reply")

    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON object in reply")

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                parsed = json.loads(text[start : index + 1])
                if not isinstance(parsed, dict):
                    raise ValueError("reply JSON was not an object")
                return parsed

    raise ValueError("unbalanced JSON object in reply")


class Agent(Generic[T]):
    """One prompt, one schema, one pessimistic fallback.

    Subclasses supply ``schema``, ``model_name``, and ``build_prompt``.
    Everything about failure handling lives here so it cannot drift between
    agents -- the auditor and the checker must fail the same way.
    """

    name: str = "agent"
    schema: type[T]

    def __init__(self, client: GrokClient, model: str) -> None:
        self.client = client
        self.model = model
        self.failures = 0

    def build_prompt(self, *args: Any, **kwargs: Any) -> str:  # pragma: no cover
        raise NotImplementedError

    def pessimistic(self, reason: str) -> T:
        """The value returned when the check could not be completed."""
        return self.schema.pessimistic(reason)  # type: ignore[attr-defined]

    async def run(self, *args: Any, **kwargs: Any) -> T:
        """Build, call, parse, validate -- and never raise.

        Returning rather than raising is deliberate: a caller that has to
        remember a try/except around every agent will eventually forget
        one, and the forgotten one would be a silent pass.
        """
        try:
            prompt = self.build_prompt(*args, **kwargs)
        except Exception as exc:
            # Prompt building touches provider payloads of uncertain shape.
            # It is inside the guarantee too: an agent that raised here
            # would be exactly the silent gap this design forbids.
            self.failures += 1
            log.warning("%s: could not build prompt (%s)", self.name, exc)
            return self.pessimistic(f"prompt build failed: {exc}")

        try:
            text = await self.client.complete(self.model, prompt)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.failures += 1
            log.warning("%s: call failed, returning pessimistic result (%s)", self.name, exc)
            return self.pessimistic(f"call failed: {exc}")

        try:
            data = parse_json_object(text)
        except (ValueError, json.JSONDecodeError) as exc:
            self.failures += 1
            log.warning("%s: unparseable reply, returning pessimistic result (%s)", self.name, exc)
            return self.pessimistic(f"unparseable reply: {exc}")

        try:
            return self.schema.model_validate(data)
        except ValidationError as exc:
            self.failures += 1
            log.warning("%s: reply did not fit schema (%s)", self.name, exc.error_count())
            return self.pessimistic("reply did not fit schema")


JSON_ONLY = (
    "Reply with ONLY a JSON object matching the shape above. "
    "No markdown fence, no prose, no explanation before or after."
)
