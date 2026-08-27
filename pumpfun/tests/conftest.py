"""Shared fixtures. No test in this suite touches the network."""

from __future__ import annotations

import pytest

from src.models import Analysis, Config, Token


@pytest.fixture
def config() -> Config:
    return Config.model_validate({
        "mode": "dry-run",
        "grok": {"api_key": "xai-test"},
        "data": {"api_key": "data-test"},
    })


@pytest.fixture
def token() -> Token:
    return Token(
        mint="MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        name="Bald Cat",
        symbol="BALDCAT",
        description="a cat, but bald",
        image_url="https://example.invalid/cat.png",
        twitter="https://x.invalid/baldcat",
        creator="CreatorAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        bonding_curve_pct=12.0,
        unique_buyers=25,
        volume_sol=8.0,
        age_minutes=6.0,
        risk_score=3.0,
    )


@pytest.fixture
def analysis() -> Analysis:
    return Analysis(
        risk_score=3.0,
        sniper_count=1,
        insider_pct=0.18,
        creator_pct=0.04,
        curve_health=0.82,
        social_signal=0.67,
        wallet_diversity=0.75,
        trades=[{"wallet": f"w{i}", "side": "buy", "amount_sol": 0.2} for i in range(10)],
        holders=[{"address": f"h{i}", "percentage": 3.0} for i in range(10)],
    )
