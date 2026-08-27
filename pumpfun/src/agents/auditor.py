"""Agent 1: wallet behaviour.

Given raw trades and holders -- not aggregates, the transactions
themselves -- find the patterns that averages hide: buys of matching size
seconds apart, a wallet trading with itself, a creator splitting a position
before dumping it.

This is the first agent because it is the one whose failure is most
expensive to miss, and its input is already in hand from the analyzer.
"""

from __future__ import annotations

from typing import Any

from ..models import AuditResult, Token
from .base import JSON_ONLY, Agent

PROMPT = """You are auditing wallet behaviour for a new memecoin on pump.fun.

Token: {name} ({symbol}), {age:.0f} minutes old, curve at {curve:.1f}%

Trades, earliest first:
{trades}

Top holders:
{holders}

Judge only what these rows show. Rate:
1. coordinated_buys: buys that look driven by one operator (matching
   amounts, gaps under 5s, a burst in the first seconds of life)
2. wash_trading: the same wallet buying and selling to manufacture volume
3. creator_dump_risk: 0.0-1.0, how much this looks like a dump being set up
4. organic_score: 0.0-1.0, the fraction of buyers that look independent

If the rows are too few or too thin to judge, raise the flag rather than
excusing the token: absent evidence is not evidence of innocence.

{{"coordinated_buys": false, "wash_trading": false,
  "creator_dump_risk": 0.0, "organic_score": 0.0, "notes": ""}}

""" + JSON_ONLY


class WalletAuditor(Agent[AuditResult]):
    name = "auditor"
    schema = AuditResult

    def build_prompt(  # type: ignore[override]
        self,
        token: Token,
        trades: list[dict[str, Any]],
        holders: list[dict[str, Any]],
    ) -> str:
        return PROMPT.format(
            name=token.name or "?",
            symbol=token.symbol or "?",
            age=token.age_minutes,
            curve=token.bonding_curve_pct,
            trades=format_trades(trades) or "  (none reported)",
            holders=format_holders(holders) or "  (none reported)",
        )


def format_trades(trades: list[dict[str, Any]], limit: int = 30) -> str:
    lines = []
    for trade in trades[:limit]:
        wallet = str(trade.get("wallet") or trade.get("owner") or "?")[:8]
        side = trade.get("side") or trade.get("type") or "?"
        amount = _num(trade, "amount_sol", "amountSol", "solAmount", "volume")
        offset = _num(trade, "seconds_after_launch", "secondsAfterLaunch", "age")
        lines.append(f"  {wallet}... | {side} | {amount:.3f} SOL | +{offset:.0f}s")
    return "\n".join(lines)


def format_holders(holders: list[dict[str, Any]], limit: int = 10) -> str:
    lines = []
    for holder in holders[:limit]:
        address = str(holder.get("address") or holder.get("wallet") or "?")[:8]
        pct = _num(holder, "percentage", "percent", "pct")
        if pct <= 1.0:
            pct *= 100.0
        tag = "sniper" if holder.get("is_sniper") or holder.get("isSniper") else "organic"
        lines.append(f"  {address}... | {pct:.1f}% | {tag}")
    return "\n".join(lines)


def _num(data: dict[str, Any], *keys: str) -> float:
    for key in keys:
        value = data.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return 0.0
