"""Stage 6: the scoring matrix.

This is code, and that is the point. The agents return numbers; this
function turns numbers into a total; a threshold turns the total into a
decision. No model is asked whether to buy, so no model reply -- however
confident, however well argued -- can move money by itself.

Weights are normalised, so writing 0.5/0.5/0.5/0.5 in the config keeps the
proportions and still yields a total in 0..1. Without that, a threshold
tuned against one weight set would silently mean something different under
another.
"""

from __future__ import annotations

from .analyzer import metrics_component
from .models import (
    Analysis,
    AuditResult,
    NarrativeResult,
    ScoreBreakdown,
    ScoringConfig,
    TimingResult,
)


def compute_score(
    analysis: Analysis,
    audit: AuditResult,
    narrative: NarrativeResult,
    timing: TimingResult,
    config: ScoringConfig,
) -> ScoreBreakdown:
    """Weighted total of the four components, each already in 0..1."""
    weights = config.weights.normalized()

    audit_component = audit.component
    narrative_component = narrative.component
    timing_component = timing.component
    metrics = metrics_component(analysis)

    total = (
        weights["audit"] * audit_component
        + weights["narrative"] * narrative_component
        + weights["timing"] * timing_component
        + weights["metrics"] * metrics
    )

    return ScoreBreakdown(
        audit=round(audit_component, 4),
        narrative=round(narrative_component, 4),
        timing=round(timing_component, 4),
        metrics=round(metrics, 4),
        total=round(max(0.0, min(1.0, total)), 4),
    )


def rescore(components: dict[str, float], weights: dict[str, float]) -> float:
    """Recompute a total from stored components under different weights.

    Used by ``scripts/tune.py``. Because every log record keeps its
    components, history can be re-scored without calling a single agent
    again.
    """
    total_weight = sum(weights.values())
    if total_weight <= 0:
        return 0.0
    value = sum(
        weights.get(key, 0.0) / total_weight * float(components.get(key, 0.0))
        for key in ("audit", "narrative", "timing", "metrics")
    )
    return max(0.0, min(1.0, value))
