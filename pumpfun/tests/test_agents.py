"""The agents, and the rule that a failed check is a rejection.

Every failure mode a real endpoint produces is exercised here: a timeout,
a 500, prose instead of JSON, JSON that does not fit the schema, and an
empty completion. In every case the agent must return its pessimistic
value -- never a neutral one, and never an exception the caller might
forget to catch.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from src.agents import (
    AdversarialChecker,
    GrokClient,
    MarketTimingAgent,
    NarrativeScorer,
    WalletAuditor,
)
from src.agents.base import GrokError, parse_json_object
from src.models import (
    Analysis,
    AuditResult,
    NarrativeResult,
    ScoreBreakdown,
    TimingResult,
    Token,
)

BASE = "https://api.test.invalid/v1"
ENDPOINT = f"{BASE}/chat/completions"


def reply(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


async def make_client(**kwargs) -> GrokClient:
    client = GrokClient(api_key="k", base_url=BASE, timeout=2.0,
                        max_retries=kwargs.pop("max_retries", 0), **kwargs)
    await client.__aenter__()
    return client


@pytest.fixture
def token() -> Token:
    return Token(mint="M" * 32, name="Cat", symbol="CAT", creator="C" * 32)


# -- the happy path --------------------------------------------------------


@respx.mock
async def test_auditor_parses_a_clean_reply(token):
    respx.post(ENDPOINT).mock(return_value=reply(
        '{"coordinated_buys": false, "wash_trading": false,'
        ' "creator_dump_risk": 0.2, "organic_score": 0.8}'
    ))
    agent = WalletAuditor(await make_client(), "grok-4-fast")
    result = await agent.run(token, [], [])
    assert result.organic_score == 0.8
    assert not result.coordinated_buys


@respx.mock
async def test_reply_wrapped_in_a_markdown_fence_still_parses(token):
    respx.post(ENDPOINT).mock(return_value=reply(
        'Sure!\n```json\n{"narrative_fit": 0.7, "virality": 0.6,'
        ' "community": 0.5, "timing": 0.4}\n```\nHope that helps.'
    ))
    agent = NarrativeScorer(await make_client(), "grok-4-fast")
    result = await agent.run(token, Analysis())
    assert result.narrative_fit == 0.7


# -- failure modes ---------------------------------------------------------


@respx.mock
@pytest.mark.parametrize(
    "response",
    [
        pytest.param(reply("I think this token looks great!"), id="prose_not_json"),
        pytest.param(reply(""), id="empty_completion"),
        pytest.param(reply('{"coordinated_buys": "maybe"}'), id="wrong_types"),
        pytest.param(reply('{"organic_score": '), id="truncated_json"),
        pytest.param(httpx.Response(500), id="server_error"),
        pytest.param(httpx.Response(429), id="rate_limited"),
    ],
)
async def test_auditor_returns_every_flag_on_failure(token, response):
    respx.post(ENDPOINT).mock(return_value=response)
    agent = WalletAuditor(await make_client(), "grok-4-fast")
    result = await agent.run(token, [], [])

    assert result.coordinated_buys is True
    assert result.wash_trading is True
    assert result.creator_dump_risk == 1.0
    assert result.organic_score == 0.0
    assert result.component == 0.0
    assert agent.failures == 1


@respx.mock
async def test_auditor_returns_pessimistic_on_timeout(token):
    respx.post(ENDPOINT).mock(side_effect=httpx.ReadTimeout("too slow"))
    agent = WalletAuditor(await make_client(), "grok-4-fast")
    result = await agent.run(token, [], [])
    assert result.creator_dump_risk == 1.0


@respx.mock
@pytest.mark.parametrize(
    "response",
    [
        pytest.param(reply("no json at all"), id="prose"),
        pytest.param(httpx.Response(503), id="unavailable"),
        pytest.param(reply('{"approve": true'), id="truncated"),
    ],
)
async def test_checker_refuses_when_it_cannot_answer(token, response):
    """The single most important assertion in the suite: a checker that
    could not run must not approve."""
    respx.post(ENDPOINT).mock(return_value=response)
    agent = AdversarialChecker(await make_client(), "grok-4")
    result = await agent.run(token, Analysis(), AuditResult(), NarrativeResult(),
                             TimingResult(), ScoreBreakdown(total=0.9))
    assert result.approve is False
    assert "agent_error" in result.risk_flags


@respx.mock
async def test_narrative_scores_zero_when_it_fails(token):
    respx.post(ENDPOINT).mock(return_value=httpx.Response(500))
    agent = NarrativeScorer(await make_client(), "grok-4-fast")
    result = await agent.run(token, Analysis())
    assert result.component == 0.0


@respx.mock
async def test_agents_never_raise_out_of_run(token):
    respx.post(ENDPOINT).mock(side_effect=httpx.ConnectError("no route"))
    auditor = WalletAuditor(await make_client(), "m")
    narrative = NarrativeScorer(await make_client(), "m")
    assert (await auditor.run(token, [], [])).creator_dump_risk == 1.0
    assert (await narrative.run(token, Analysis())).component == 0.0


async def test_a_crash_while_building_the_prompt_is_also_a_rejection(token):
    """Provider payloads have uncertain shapes. A formatting crash must
    return the pessimistic value like any other failed check, not escape as
    an exception the caller may not be guarding."""
    agent = WalletAuditor(await make_client(), "m")
    agent.build_prompt = lambda *a, **k: (_ for _ in ()).throw(KeyError("surprise"))
    result = await agent.run(token, [], [])
    assert result.coordinated_buys is True
    assert result.organic_score == 0.0
    assert agent.failures == 1


async def test_checker_rejects_when_prompt_building_crashes(token):
    agent = AdversarialChecker(await make_client(), "m")
    agent.build_prompt = lambda *a, **k: (_ for _ in ()).throw(TypeError("bad shape"))
    result = await agent.run(token, Analysis(), AuditResult(), NarrativeResult(),
                             TimingResult(), ScoreBreakdown())
    assert result.approve is False


# -- retries and limiters --------------------------------------------------


@respx.mock
async def test_transient_failure_is_retried_then_succeeds(token):
    route = respx.post(ENDPOINT).mock(side_effect=[
        httpx.Response(503),
        reply('{"coordinated_buys": false, "wash_trading": false,'
              ' "creator_dump_risk": 0.1, "organic_score": 0.9}'),
    ])
    agent = WalletAuditor(await make_client(max_retries=2), "grok-4-fast")
    result = await agent.run(token, [], [])
    assert result.organic_score == 0.9
    assert route.call_count == 2


@respx.mock
async def test_a_refusing_limiter_prevents_the_call_entirely(token):
    route = respx.post(ENDPOINT).mock(return_value=reply("{}"))

    class Closed:
        async def acquire(self):
            return False

        def record_success(self):
            pass

        def record_failure(self):
            pass

    agent = WalletAuditor(await make_client(limiter=Closed()), "grok-4-fast")
    result = await agent.run(token, [], [])
    assert result.creator_dump_risk == 1.0, "an unmade call is a failed check"
    assert route.call_count == 0


# -- the timing cache ------------------------------------------------------


@respx.mock
async def test_timing_verdict_is_cached_across_tokens():
    route = respx.post(ENDPOINT).mock(return_value=reply(
        '{"market_mood": 0.6, "meme_season": 0.7,'
        ' "volume_signal": 0.5, "timing_score": 0.65}'
    ))
    agent = MarketTimingAgent(await make_client(), "grok-4-fast", cache_seconds=900)
    first = await agent.evaluate({"hour_utc": 12})
    second = await agent.evaluate({"hour_utc": 12})
    assert route.call_count == 1
    assert first.timing_score == second.timing_score == 0.65
    assert agent.cache_hits == 1


@respx.mock
async def test_concurrent_timing_requests_collapse_into_one_call():
    """A burst of launches must not buy the same verdict twenty times."""
    import asyncio

    route = respx.post(ENDPOINT).mock(return_value=reply(
        '{"market_mood": 0.5, "meme_season": 0.5,'
        ' "volume_signal": 0.5, "timing_score": 0.5}'
    ))
    agent = MarketTimingAgent(await make_client(), "grok-4-fast", cache_seconds=900)
    results = await asyncio.gather(*(agent.evaluate({"hour_utc": 3}) for _ in range(20)))
    assert route.call_count == 1
    assert all(r.timing_score == 0.5 for r in results)


@respx.mock
async def test_a_failed_timing_verdict_is_not_cached():
    """Otherwise one bad call would pin a pessimistic backdrop in place for
    the whole window."""
    route = respx.post(ENDPOINT).mock(side_effect=[
        httpx.Response(500),
        reply('{"market_mood": 0.8, "meme_season": 0.8,'
              ' "volume_signal": 0.8, "timing_score": 0.8}'),
    ])
    agent = MarketTimingAgent(await make_client(), "grok-4-fast", cache_seconds=900)
    first = await agent.evaluate({})
    second = await agent.evaluate({})
    assert route.call_count == 2
    assert first.timing_score == 0.3
    assert second.timing_score == 0.8


@respx.mock
async def test_timing_cache_expires():
    route = respx.post(ENDPOINT).mock(return_value=reply(
        '{"market_mood": 0.5, "meme_season": 0.5,'
        ' "volume_signal": 0.5, "timing_score": 0.5}'
    ))
    agent = MarketTimingAgent(await make_client(), "grok-4-fast", cache_seconds=0.0)
    await agent.evaluate({})
    await agent.evaluate({})
    assert route.call_count == 2


# -- the JSON extractor ----------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ('{"a": 1}', {"a": 1}),
        ('```json\n{"a": 1}\n```', {"a": 1}),
        ('prefix {"a": 1} suffix', {"a": 1}),
        ('{"reason": "it has a } inside", "ok": true}',
         {"reason": "it has a } inside", "ok": True}),
        ('{"reason": "escaped \\" quote"}', {"reason": 'escaped " quote'}),
        ('{"outer": {"inner": 1}}', {"outer": {"inner": 1}}),
    ],
)
def test_json_extraction_handles_real_model_output(text, expected):
    assert parse_json_object(text) == expected


@pytest.mark.parametrize("text", ["", "no braces", "{unbalanced", "[1,2,3]"])
def test_json_extraction_rejects_what_it_cannot_parse(text):
    with pytest.raises(ValueError):
        parse_json_object(text)


@respx.mock
async def test_client_raises_after_exhausting_retries():
    respx.post(ENDPOINT).mock(return_value=httpx.Response(500))
    client = await make_client(max_retries=1)
    with pytest.raises(GrokError, match="after 2 attempts"):
        await client.complete("m", "p")
