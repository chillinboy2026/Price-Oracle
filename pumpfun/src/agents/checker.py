"""Agent 4: the adversarial check.

Every other agent in the pipeline is working toward approval by the time
this one runs. This agent is the only one forbidden from looking for a
reason to buy, and it runs on the stronger model, because it is the last
thing between the pipeline and money.

Separating the roles matters more than the model does: a generator asked
to grade its own output is generous about it. This one was given the
opposite instruction, so it is not.

``approve: false`` is a normal outcome here, not a malfunction.
"""

from __future__ import annotations

from ..models import (
    Analysis,
    AuditResult,
    CheckerResult,
    NarrativeResult,
    ScoreBreakdown,
    TimingResult,
    Token,
)
from .base import JSON_ONLY, Agent

PROMPT = """You are the adversarial check on a memecoin buy. Every stage
before you approved this token. Your job is to find the reason not to buy.

Token: {name} ({symbol}), {age:.0f} min old, curve {curve:.1f}%, \
{buyers} buyers
Total score: {total:.2f} (threshold cleared)

Component scores:
  audit     {audit:.2f}
  narrative {narrative:.2f}
  timing    {timing:.2f}
  metrics   {metrics:.2f}

Audit: coordinated_buys={coordinated}, wash_trading={wash},
  creator_dump_risk={dump:.2f}, organic={organic:.2f}
Narrative: fit={fit:.2f}, virality={virality:.2f}, community={community:.2f}
Timing: score={timing_score:.2f}, meme_season={meme_season:.2f}
Metrics: risk={risk:.1f}/10, top5 hold {insider:.0%}, creator holds \
{creator:.0%}, snipers={snipers}, wallet diversity={diversity:.2f}

Look specifically for:
- contradictions between components (strong meme, weak organics; healthy
  curve, concentrated holders)
- a total carried by one component while the others are poor
- red flags the earlier stages had the data to catch but did not

Set approve=false if you find a serious one. Listing no flags when the
numbers above contain one is the failure mode to avoid.

{{"approve": true, "confidence": 0.0, "risk_flags": [], "reason": ""}}

""" + JSON_ONLY


class AdversarialChecker(Agent[CheckerResult]):
    name = "checker"
    schema = CheckerResult

    def build_prompt(  # type: ignore[override]
        self,
        token: Token,
        analysis: Analysis,
        audit: AuditResult,
        narrative: NarrativeResult,
        timing: TimingResult,
        score: ScoreBreakdown,
    ) -> str:
        return PROMPT.format(
            name=token.name or "?",
            symbol=token.symbol or "?",
            age=token.age_minutes,
            curve=token.bonding_curve_pct,
            buyers=token.unique_buyers,
            total=score.total,
            audit=score.audit,
            narrative=score.narrative,
            timing=score.timing,
            metrics=score.metrics,
            coordinated=audit.coordinated_buys,
            wash=audit.wash_trading,
            dump=audit.creator_dump_risk,
            organic=audit.organic_score,
            fit=narrative.narrative_fit,
            virality=narrative.virality,
            community=narrative.community,
            timing_score=timing.timing_score,
            meme_season=timing.meme_season,
            risk=analysis.risk_score,
            insider=analysis.insider_pct,
            creator=analysis.creator_pct,
            snipers=analysis.sniper_count,
            diversity=analysis.wallet_diversity,
        )
