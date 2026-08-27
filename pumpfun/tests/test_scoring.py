"""Stage 6: the matrix. Weights, normalisation, and component behaviour."""

from __future__ import annotations

import pytest

from src.models import (
    Analysis,
    AuditResult,
    NarrativeResult,
    ScoringConfig,
    ScoringWeights,
    TimingResult,
)
from src.scoring import compute_score, rescore


def score(analysis=None, audit=None, narrative=None, timing=None, config=None):
    return compute_score(
        analysis or Analysis(),
        audit or AuditResult(),
        narrative or NarrativeResult(),
        timing or TimingResult(),
        config or ScoringConfig(),
    )


def test_total_stays_in_range_at_both_extremes():
    worst = score(
        analysis=Analysis(risk_score=10.0, curve_health=0.0, wallet_diversity=0.0,
                          social_signal=0.0, sniper_count=10),
        audit=AuditResult.pessimistic(),
        narrative=NarrativeResult.pessimistic(),
        timing=TimingResult(market_mood=0, meme_season=0, volume_signal=0, timing_score=0),
    )
    best = score(
        analysis=Analysis(risk_score=0.0, curve_health=1.0, wallet_diversity=1.0,
                          social_signal=1.0, sniper_count=0),
        audit=AuditResult(coordinated_buys=False, wash_trading=False,
                          creator_dump_risk=0.0, organic_score=1.0),
        narrative=NarrativeResult(narrative_fit=1, virality=1, community=1, timing=1),
        timing=TimingResult(market_mood=1, meme_season=1, volume_signal=1, timing_score=1),
    )
    assert worst.total == 0.0
    assert best.total == pytest.approx(1.0, abs=1e-6)


def test_weights_are_normalised_so_the_threshold_keeps_meaning():
    """Doubling every weight must not change the total."""
    analysis = Analysis(risk_score=4.0, curve_health=0.7, wallet_diversity=0.6)
    audit = AuditResult(coordinated_buys=False, wash_trading=False,
                        creator_dump_risk=0.2, organic_score=0.8)
    single = score(analysis, audit, config=ScoringConfig(
        weights=ScoringWeights(audit=0.3, narrative=0.25, timing=0.15, metrics=0.3)))
    doubled = score(analysis, audit, config=ScoringConfig(
        weights=ScoringWeights(audit=0.6, narrative=0.5, timing=0.3, metrics=0.6)))
    assert single.total == pytest.approx(doubled.total)


def test_all_zero_weights_are_rejected_at_config_time():
    with pytest.raises(ValueError, match="sum to zero"):
        ScoringWeights(audit=0, narrative=0, timing=0, metrics=0)


def test_components_are_stored_for_later_retuning():
    breakdown = score()
    assert {"audit", "narrative", "timing", "metrics"} <= set(breakdown.model_dump())
    assert breakdown.weakest in {"audit", "narrative", "timing", "metrics"}


def test_audit_flags_multiply_the_component_down():
    clean = AuditResult(coordinated_buys=False, wash_trading=False,
                        creator_dump_risk=0.0, organic_score=1.0)
    flagged = clean.model_copy(update={"coordinated_buys": True})
    both = clean.model_copy(update={"coordinated_buys": True, "wash_trading": True})
    assert clean.component == 1.0
    assert flagged.component == pytest.approx(0.4)
    assert both.component == pytest.approx(0.16)


def test_dump_risk_erases_an_otherwise_organic_audit():
    audit = AuditResult(coordinated_buys=False, wash_trading=False,
                        creator_dump_risk=1.0, organic_score=1.0)
    assert audit.component == 0.0


def test_pessimistic_timing_is_low_but_not_zero():
    """A failed timing call must bias against trading without zeroing
    every token in the window -- timing is shared, not per-token."""
    assert 0.0 < TimingResult.pessimistic().component < 0.4


def test_rescore_reproduces_compute_score_from_stored_components():
    breakdown = score(
        analysis=Analysis(risk_score=2.0, curve_health=0.9, wallet_diversity=0.8),
        audit=AuditResult(coordinated_buys=False, wash_trading=False,
                          creator_dump_risk=0.1, organic_score=0.9),
    )
    weights = ScoringWeights().normalized()
    again = rescore(
        {"audit": breakdown.audit, "narrative": breakdown.narrative,
         "timing": breakdown.timing, "metrics": breakdown.metrics},
        weights,
    )
    assert again == pytest.approx(breakdown.total, abs=1e-3)


def test_rescore_survives_zero_weights():
    assert rescore({"audit": 1.0}, {"audit": 0.0}) == 0.0
