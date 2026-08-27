"""Notifications: formats, rate limiting, transitions, and secrecy."""

from __future__ import annotations

import json
import logging

import httpx
import pytest
import respx

from src.alerts import TELEGRAM_API, Alerter
from src.models import Config

WEBHOOK = "https://hooks.test.invalid/T000/B000/secret-webhook-token"
BOT_TOKEN = "123456:ABC-secret-bot-token"
CHAT_ID = "987654321"


async def make(fmt="generic", webhook=WEBHOOK, token="", chat="",
               min_interval=0.0) -> Alerter:
    alerter = Alerter(webhook, min_interval, fmt=fmt,
                      telegram_bot_token=token, telegram_chat_id=chat)
    await alerter.__aenter__()
    return alerter


# -- formats ---------------------------------------------------------------


@respx.mock
async def test_generic_posts_the_full_structured_payload():
    route = respx.post(WEBHOOK).mock(return_value=httpx.Response(200))
    alerter = await make()
    assert await alerter.send("buy", "bought CAT for 0.05 SOL", score=0.72)

    body = json.loads(route.calls[0].request.content)
    assert body["event"] == "buy"
    assert body["text"] == "bought CAT for 0.05 SOL"
    assert body["score"] == 0.72
    assert "timestamp" in body


@respx.mock
async def test_slack_gets_a_text_line():
    route = respx.post(WEBHOOK).mock(return_value=httpx.Response(200))
    alerter = await make(fmt="slack")
    await alerter.send("buy", "bought CAT for 0.05 SOL")
    assert json.loads(route.calls[0].request.content) == {
        "text": "[buy] bought CAT for 0.05 SOL"
    }


@respx.mock
async def test_discord_gets_a_content_line():
    route = respx.post(WEBHOOK).mock(return_value=httpx.Response(200))
    alerter = await make(fmt="discord")
    await alerter.send("close", "closed CAT (stop_loss) -60.0%")
    assert json.loads(route.calls[0].request.content) == {
        "content": "[close] closed CAT (stop_loss) -60.0%"
    }


@respx.mock
async def test_telegram_calls_the_bot_api_with_chat_id():
    route = respx.post(f"{TELEGRAM_API}/bot{BOT_TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True}))
    alerter = await make(fmt="telegram", webhook="", token=BOT_TOKEN, chat=CHAT_ID)
    assert await alerter.send("buy", "bought CAT for 0.05 SOL")

    body = json.loads(route.calls[0].request.content)
    assert body == {"chat_id": CHAT_ID, "text": "[buy] bought CAT for 0.05 SOL"}


# -- enablement ------------------------------------------------------------


async def test_no_webhook_means_disabled_and_silent():
    alerter = await make(webhook="")
    assert not alerter.enabled
    assert not await alerter.send("buy", "x")


async def test_telegram_needs_both_token_and_chat_id():
    assert not (await make(fmt="telegram", webhook="", token=BOT_TOKEN)).enabled
    assert not (await make(fmt="telegram", webhook="", chat=CHAT_ID)).enabled
    assert (await make(fmt="telegram", webhook="", token=BOT_TOKEN, chat=CHAT_ID)).enabled


async def test_telegram_ignores_a_webhook_url():
    """A leftover webhook from a previous format must not enable anything."""
    alerter = await make(fmt="telegram", webhook=WEBHOOK)
    assert not alerter.enabled


# -- rate limiting and transitions -----------------------------------------


@respx.mock
async def test_sends_inside_the_interval_are_suppressed():
    respx.post(WEBHOOK).mock(return_value=httpx.Response(200))
    alerter = await make(min_interval=60.0)
    assert await alerter.send("a", "first")
    assert not await alerter.send("b", "second")
    assert alerter.sent == 1
    assert alerter.suppressed == 1


@respx.mock
async def test_on_change_fires_only_on_transitions():
    route = respx.post(WEBHOOK).mock(return_value=httpx.Response(200))
    alerter = await make()
    assert await alerter.on_change("breaker", True, "opened")
    assert not await alerter.on_change("breaker", True, "opened")
    assert not await alerter.on_change("breaker", True, "opened")
    assert await alerter.on_change("breaker", False, "closed")
    assert route.call_count == 2


# -- failure behaviour -----------------------------------------------------


@respx.mock
async def test_a_failed_send_is_swallowed_and_counted():
    respx.post(WEBHOOK).mock(return_value=httpx.Response(500))
    alerter = await make()
    assert not await alerter.send("buy", "x")
    assert alerter.failed == 1


@respx.mock
async def test_a_connection_error_is_swallowed():
    respx.post(WEBHOOK).mock(side_effect=httpx.ConnectError("no route"))
    alerter = await make()
    assert not await alerter.send("buy", "x")


@respx.mock
@pytest.mark.parametrize(
    ("fmt", "kwargs", "response"),
    [
        ("generic", {}, httpx.Response(500)),
        ("generic", {}, None),  # ConnectError carries the URL in its message
        ("telegram", {"webhook": "", "token": BOT_TOKEN, "chat": CHAT_ID},
         httpx.Response(400, json={"ok": False})),
    ],
)
async def test_failure_logs_never_contain_the_token(fmt, kwargs, response, caplog):
    """httpx exception messages embed the URL, and alert URLs carry
    tokens -- the webhook path secret, or the Telegram bot token."""
    if response is None:
        respx.post(url__regex=r".*").mock(side_effect=httpx.ConnectError(
            f"cannot reach {WEBHOOK}"))
    else:
        respx.post(url__regex=r".*").mock(return_value=response)

    alerter = await make(fmt=fmt, **kwargs)
    with caplog.at_level(logging.DEBUG):
        await alerter.send("buy", "x")

    logged = " ".join(record.getMessage() for record in caplog.records)
    assert "secret-webhook-token" not in logged
    assert "secret-bot-token" not in logged


# -- config validation -----------------------------------------------------


def test_telegram_format_without_credentials_blocks_startup():
    config = Config.model_validate({
        "grok": {"api_key": "xai-real"},
        "alerts": {"format": "telegram"},
    })
    assert any("telegram" in p for p in config.problems())


def test_slack_format_without_a_webhook_blocks_startup():
    config = Config.model_validate({
        "grok": {"api_key": "xai-real"},
        "alerts": {"format": "slack"},
    })
    assert any("webhook_url is unset" in p for p in config.problems())


def test_the_default_quiet_config_is_not_an_error():
    config = Config.model_validate({"grok": {"api_key": "xai-real"}})
    assert config.problems() == []


def test_a_configured_telegram_setup_is_valid():
    config = Config.model_validate({
        "grok": {"api_key": "xai-real"},
        "alerts": {"format": "telegram",
                   "telegram_bot_token": BOT_TOKEN,
                   "telegram_chat_id": CHAT_ID},
    })
    assert config.problems() == []


def test_the_bot_token_is_masked_like_every_other_secret():
    config = Config.model_validate({
        "grok": {"api_key": "x"},
        "alerts": {"format": "telegram",
                   "telegram_bot_token": BOT_TOKEN,
                   "telegram_chat_id": CHAT_ID},
    })
    assert BOT_TOKEN not in str(config.masked())
    assert config.masked()["alerts"]["telegram_bot_token"] == "***set***"
