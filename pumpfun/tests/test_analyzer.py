"""Stage 2: metric reduction and the unconditional vetoes."""

from __future__ import annotations

import httpx
import pytest
import respx

from src.analyzer import AnalyzerError, TokenAnalyzer, concentration_veto, metrics_component
from src.models import Analysis, FilterConfig, Token

BASE = "https://data.test.invalid"


@pytest.fixture
def analyzer() -> TokenAnalyzer:
    return TokenAnalyzer(BASE, "key")


def test_reduction_computes_concentration_and_diversity(analyzer):
    token = Token(mint="m", creator="DEV", twitter="t")
    detail = {"risk": {"score": 3}, "website": "w"}
    holders = [{"address": "DEV", "percentage": 30.0, "is_sniper": True}] + [
        {"address": f"w{i}", "percentage": 5.0} for i in range(6)
    ]
    trades = [{"wallet": f"w{i % 4}"} for i in range(20)]

    analysis = analyzer.reduce(token, detail, holders, trades)
    assert analysis.creator_pct == pytest.approx(0.30)
    assert analysis.insider_pct == pytest.approx(0.50)
    assert analysis.curve_health == pytest.approx(0.50)
    assert analysis.wallet_diversity == pytest.approx(0.20)
    assert analysis.social_signal == pytest.approx(2 / 3)
    assert analysis.sniper_count == 1


def test_percentages_are_read_in_either_convention(analyzer):
    """Providers report holdings as 0..1 or 0..100."""
    token = Token(mint="m")
    as_fraction = analyzer.reduce(token, {}, [{"address": "a", "percentage": 0.30}], [])
    as_percent = analyzer.reduce(token, {}, [{"address": "a", "percentage": 30.0}], [])
    assert as_fraction.insider_pct == as_percent.insider_pct == pytest.approx(0.30)


def test_empty_payloads_do_not_crash(analyzer):
    analysis = analyzer.reduce(Token(mint="m"), {}, [], [])
    assert analysis.wallet_diversity == 0.0
    assert analysis.curve_health == 1.0


# -- the vetoes ------------------------------------------------------------


def test_creator_concentration_is_an_unconditional_veto():
    analysis = Analysis(creator_pct=0.30, risk_score=1.0)
    assert concentration_veto(analysis, FilterConfig()) == "creator_concentration"


def test_top5_concentration_is_an_unconditional_veto():
    analysis = Analysis(insider_pct=0.85, risk_score=1.0)
    assert concentration_veto(analysis, FilterConfig()) == "top5_concentration"


def test_high_risk_score_vetoes():
    assert concentration_veto(Analysis(risk_score=9.0), FilterConfig()) == "high_risk"


def test_a_clean_token_is_not_vetoed():
    analysis = Analysis(risk_score=3.0, creator_pct=0.05, insider_pct=0.20)
    assert concentration_veto(analysis, FilterConfig()) is None


def test_veto_thresholds_are_configurable():
    analysis = Analysis(creator_pct=0.30, risk_score=1.0)
    loose = FilterConfig(max_creator_hold_pct=50.0)
    assert concentration_veto(analysis, loose) is None


# -- the metrics component -------------------------------------------------


def test_metrics_component_rewards_a_healthy_token():
    good = metrics_component(Analysis(risk_score=0, curve_health=1.0,
                                      wallet_diversity=1.0, social_signal=1.0))
    bad = metrics_component(Analysis(risk_score=10, curve_health=0.0,
                                     wallet_diversity=0.0, sniper_count=10))
    assert good == pytest.approx(1.0)
    assert bad == 0.0


def test_snipers_reduce_the_component():
    clean = metrics_component(Analysis(risk_score=3, curve_health=0.8, sniper_count=0))
    sniped = metrics_component(Analysis(risk_score=3, curve_health=0.8, sniper_count=8))
    assert sniped < clean


# -- fetching --------------------------------------------------------------


@respx.mock
async def test_analyze_gathers_three_endpoints():
    respx.get(url__regex=rf"{BASE}/tokens/[^/]+$").mock(
        return_value=httpx.Response(200, json={"risk": {"score": 2}}))
    respx.get(url__regex=rf"{BASE}/tokens/.+/holders/top").mock(
        return_value=httpx.Response(200, json=[{"address": "a", "percentage": 10.0}]))
    respx.get(url__regex=rf"{BASE}/tokens/.+/trades").mock(
        return_value=httpx.Response(200, json=[{"wallet": "w1"}, {"wallet": "w2"}]))

    async with TokenAnalyzer(BASE, "key") as analyzer:
        analysis = await analyzer.analyze(Token(mint="m"))
    assert analysis.risk_score == 2
    assert analysis.wallet_diversity == pytest.approx(1.0)


@respx.mock
async def test_a_partial_failure_degrades_rather_than_aborts():
    respx.get(url__regex=rf"{BASE}/tokens/[^/]+$").mock(
        return_value=httpx.Response(200, json={"risk": {"score": 4}}))
    respx.get(url__regex=rf"{BASE}/tokens/.+/holders/top").mock(
        return_value=httpx.Response(500))
    respx.get(url__regex=rf"{BASE}/tokens/.+/trades").mock(
        return_value=httpx.Response(200, json=[{"wallet": "w1"}]))

    async with TokenAnalyzer(BASE, "key") as analyzer:
        analysis = await analyzer.analyze(Token(mint="m"))
    assert analysis.risk_score == 4
    assert analysis.holders == []


@respx.mock
async def test_a_total_failure_raises_rather_than_scoring_nothing():
    respx.get(url__regex=rf"{BASE}/.*").mock(return_value=httpx.Response(503))
    async with TokenAnalyzer(BASE, "key") as analyzer:
        with pytest.raises(AnalyzerError):
            await analyzer.analyze(Token(mint="m"))


@respx.mock
async def test_wrapped_list_payloads_are_unwrapped():
    respx.get(url__regex=rf"{BASE}/tokens/[^/]+$").mock(
        return_value=httpx.Response(200, json={}))
    respx.get(url__regex=rf"{BASE}/tokens/.+/holders/top").mock(
        return_value=httpx.Response(200, json={"holders": [{"address": "a", "percentage": 5.0}]}))
    respx.get(url__regex=rf"{BASE}/tokens/.+/trades").mock(
        return_value=httpx.Response(200, json={"data": [{"wallet": "w"}]}))

    async with TokenAnalyzer(BASE, "key") as analyzer:
        analysis = await analyzer.analyze(Token(mint="m"))
    assert len(analysis.holders) == 1
    assert len(analysis.trades) == 1
