"""Agent 2: meme potential.

This agent does not look on-chain at all. Its input is the name, ticker,
description and links; its question is whether this spreads. That is the
one judgement in the pipeline a script cannot make, and the only reason
a model is in the loop at all.
"""

from __future__ import annotations

from ..models import Analysis, NarrativeResult, Token
from .base import JSON_ONLY, Agent

PROMPT = """You are judging the meme potential of a new token on pump.fun.

Name: {name}
Ticker: {symbol}
Description: {description}
Links: twitter={twitter} website={website} telegram={telegram}
Age: {age:.0f} minutes, curve at {curve:.1f}%, {buyers} unique buyers

Rate 0.0-1.0 each, independently:
1. narrative_fit: does this hook into something happening right now
2. virality: is it funny, recognisable, or shocking enough to spread
3. community: signs of real people behind it rather than one deployer
4. timing: is this the moment for this particular joke

Score clones of yesterday's meme strictly -- being a copy of something that
already ran is a reason to mark down, not a reason to mark up. Where there
is no evidence for a dimension, score it low, not average: missing
information is not neutral information.

{{"narrative_fit": 0.0, "virality": 0.0, "community": 0.0,
  "timing": 0.0, "notes": ""}}

""" + JSON_ONLY


class NarrativeScorer(Agent[NarrativeResult]):
    name = "narrative"
    schema = NarrativeResult

    def build_prompt(self, token: Token, analysis: Analysis) -> str:  # type: ignore[override]
        return PROMPT.format(
            name=token.name or "(none)",
            symbol=token.symbol or "(none)",
            description=(token.description or "(none)")[:600],
            twitter=token.twitter or "none",
            website=token.website or "none",
            telegram=token.telegram or "none",
            age=token.age_minutes,
            curve=token.bonding_curve_pct,
            buyers=token.unique_buyers,
        )
