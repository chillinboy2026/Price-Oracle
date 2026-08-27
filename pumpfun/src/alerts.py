"""Webhook notifications for the things worth waking up for.

Four destinations behind one interface, chosen by ``alerts.format``:

* ``generic``  -- the full structured JSON payload, for your own receiver;
* ``slack``    -- a Slack incoming webhook (``{"text": ...}``);
* ``discord``  -- a Discord webhook (``{"content": ...}``);
* ``telegram`` -- the Telegram Bot API. Needs a bot token and a chat id
  rather than a webhook URL; the sender builds the ``sendMessage`` call.

Two rules keep this from becoming noise or a liability:

* **State changes are reported on the transition, not on every tick.** A
  breaker that is open for an hour sends one message, not one a second.
* **A failed send never touches trading.** The webhook is observability;
  if it is down, the pipeline carries on and logs the failure.

And one about secrecy: the destination URL is never logged, not even on
failure. Webhook URLs and the Telegram bot URL both embed a token, and
httpx exception messages include the URL -- so failures are logged by
exception type and status code only.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Literal

import httpx

log = logging.getLogger(__name__)

# httpx logs every request at INFO with the full URL, and alert URLs embed
# tokens -- webhook path secrets, the Telegram bot token. Capping these
# loggers is the only reliable way to keep those URLs out of the log; the
# exception handler below can only guard what *this* module writes. It also
# silences a per-request INFO line for every price poll, which at a 5-second
# cadence is pure noise.
for _noisy in ("httpx", "httpcore"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

AlertFormat = Literal["generic", "slack", "discord", "telegram"]

TELEGRAM_API = "https://api.telegram.org"


class Alerter:
    """Rate-limited, transition-aware notification sender."""

    def __init__(
        self,
        webhook_url: str,
        min_interval: float = 5.0,
        fmt: AlertFormat = "generic",
        telegram_bot_token: str = "",
        telegram_chat_id: str = "",
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.webhook_url = webhook_url
        self.min_interval = min_interval
        self.fmt = fmt
        self.telegram_bot_token = telegram_bot_token
        self.telegram_chat_id = telegram_chat_id
        self._client = client
        self._owns_client = client is None
        self._last_sent = 0.0
        self._states: dict[str, Any] = {}
        self.sent = 0
        self.suppressed = 0
        self.failed = 0

    @property
    def enabled(self) -> bool:
        if self.fmt == "telegram":
            return bool(self.telegram_bot_token and self.telegram_chat_id)
        return bool(self.webhook_url)

    def _target_url(self) -> str:
        if self.fmt == "telegram":
            return f"{TELEGRAM_API}/bot{self.telegram_bot_token}/sendMessage"
        return self.webhook_url

    def _payload(self, event: str, text: str, fields: dict[str, Any]) -> dict[str, Any]:
        """Shape the message for the destination.

        The chat formats get one readable line; the structured fields ride
        along only in ``generic``, where a machine is reading.
        """
        line = f"[{event}] {text}"
        if self.fmt == "slack":
            return {"text": line}
        if self.fmt == "discord":
            return {"content": line}
        if self.fmt == "telegram":
            return {"chat_id": self.telegram_chat_id, "text": line}
        return {"event": event, "text": text, "timestamp": time.time(), **fields}

    async def __aenter__(self) -> Alerter:
        if self._client is None and self.enabled:
            self._client = httpx.AsyncClient(timeout=10.0)
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def send(self, event: str, text: str, **fields: Any) -> bool:
        if not self.enabled or self._client is None:
            return False

        now = time.time()
        if now - self._last_sent < self.min_interval:
            self.suppressed += 1
            log.debug("alert %s suppressed by rate limit", event)
            return False

        try:
            response = await self._client.post(
                self._target_url(), json=self._payload(event, text, fields)
            )
            response.raise_for_status()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Deliberately swallowed: an unreachable webhook must not be
            # able to stop or slow the pipeline. And deliberately terse:
            # str(exc) on an httpx error includes the URL, and alert URLs
            # carry tokens.
            self.failed += 1
            status = getattr(getattr(exc, "response", None), "status_code", None)
            detail = f"HTTP {status}" if status else type(exc).__name__
            log.warning("alert %s could not be delivered (%s)", event, detail)
            return False

        self._last_sent = now
        self.sent += 1
        return True

    async def on_change(self, key: str, value: Any, text: str, **fields: Any) -> bool:
        """Send only when ``key`` changes value.

        This is what makes a persistent condition -- an open breaker, a
        stalled stream -- report once on entering and once on leaving,
        rather than continuously while it holds.
        """
        if self._states.get(key) == value:
            return False
        self._states[key] = value
        return await self.send(key, text, value=value, **fields)
