"""Stage 2: extended metrics, and the vetoes no score can override.

The analyzer pulls three endpoints concurrently and reduces them to a
handful of numbers. It also holds the two rules that are *not* scored:
concentration vetoes. A score is a weighted opinion and a strong component
can always drag a weak one up, but a creator sitting on a quarter of the
supply is not an opinion. Those exits are unconditional, and they happen
here so that a token that trips one never reaches a paid model call.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from .models import Analysis, FilterConfig, Token

log = logging.getLogger(__name__)

# Trades sampled per token. Enough for the auditor to see a pattern,
# small enough to keep the prompt cheap.
TRADE_SAMPLE = 50
HOLDER_SAMPLE = 20


class AnalyzerError(Exception):
    """Raised when the provider could not be reached at all."""


class TokenAnalyzer:
    """Fetches and reduces the metric view of a token."""

    def __init__(
        self,
        rest_url: str,
        api_key: str = "",
        timeout: float = 10.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.rest_url = rest_url
        self.api_key = api_key
        self.timeout = timeout
        self._client = client
        self._owns_client = client is None

    async def __aenter__(self) -> TokenAnalyzer:
        if self._client is None:
            headers = {"x-api-key": self.api_key} if self.api_key else {}
            self._client = httpx.AsyncClient(
                base_url=self.rest_url, headers=headers, timeout=self.timeout
            )
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _get(self, path: str, **params: Any) -> Any:
        if self._client is None:
            raise AnalyzerError("analyzer used outside its context manager")
        response = await self._client.get(path, params=params or None)
        response.raise_for_status()
        return response.json()

    async def analyze(self, token: Token) -> Analysis:
        """Gather every metric for one token.

        The three requests are independent, so they go out together. A
        partial failure degrades the analysis rather than aborting it --
        but a *total* failure raises, because scoring a token on no data at
        all would be scoring nothing.
        """
        results = await asyncio.gather(
            self._get(f"/tokens/{token.mint}"),
            self._get(f"/tokens/{token.mint}/holders/top"),
            self._get(f"/tokens/{token.mint}/trades", limit=TRADE_SAMPLE),
            return_exceptions=True,
        )

        if all(isinstance(item, BaseException) for item in results):
            raise AnalyzerError(f"every provider endpoint failed for {token.short}")

        detail = _as_dict(results[0])
        holders = _as_list(results[1])
        trades = _as_list(results[2])

        for item, label in zip(results, ("detail", "holders", "trades"), strict=True):
            if isinstance(item, BaseException):
                log.debug("%s endpoint failed for %s: %s", label, token.short, item)

        return self.reduce(token, detail, holders, trades)

    def reduce(
        self,
        token: Token,
        detail: dict[str, Any],
        holders: list[dict[str, Any]],
        trades: list[dict[str, Any]],
    ) -> Analysis:
        """Pure reduction of raw payloads to metrics. Tested directly."""
        holders = [h for h in holders if isinstance(h, dict)][:HOLDER_SAMPLE]
        trades = [t for t in trades if isinstance(t, dict)][:TRADE_SAMPLE]

        sniper_count = sum(1 for h in holders if _truthy(h, "is_sniper", "isSniper", "sniper"))

        top5_pct = sum(_pct(h) for h in holders[:5])
        creator_pct = 0.0
        creator = token.creator or _str(detail, "creator", "dev", "deployer")
        if creator:
            creator_pct = sum(
                _pct(h) for h in holders
                if _str(h, "address", "wallet", "owner") == creator
            )

        # Concentration is expressed as a fraction of supply in 0..1.
        insider_pct = min(1.0, top5_pct / 100.0)
        curve_health = max(0.0, 1.0 - insider_pct)

        social = [
            bool(token.twitter or _str(detail, "twitter")),
            bool(token.website or _str(detail, "website")),
            bool(token.telegram or _str(detail, "telegram")),
        ]
        social_signal = sum(social) / len(social)

        wallets = {_str(t, "wallet", "owner", "trader") for t in trades}
        wallets.discard("")
        wallet_diversity = len(wallets) / len(trades) if trades else 0.0

        pool = _first_pool(detail)

        return Analysis(
            risk_score=_risk_score(detail, token),
            sniper_count=sniper_count,
            insider_pct=insider_pct,
            creator_pct=min(1.0, creator_pct / 100.0),
            curve_health=curve_health,
            social_signal=social_signal,
            wallet_diversity=min(1.0, wallet_diversity),
            volume_sol=_num(pool.get("liquidity", {}), "quote") or token.volume_sol,
            market_cap_usd=_num(pool.get("marketCap", {}), "usd"),
            holder_count=len(holders),
            trades=trades,
            holders=holders,
        )


def concentration_veto(analysis: Analysis, config: FilterConfig) -> str | None:
    """Unconditional rejections. Returns a reason, or None to continue.

    These are separate from scoring on purpose. Everything else in the
    pipeline is a weighted opinion that a strong component can outvote;
    these two cannot be outvoted, because the loss they predict is total
    rather than probabilistic.
    """
    if analysis.risk_score > config.max_risk_score:
        return "high_risk"
    if analysis.creator_pct * 100.0 >= config.max_creator_hold_pct:
        return "creator_concentration"
    if analysis.insider_pct * 100.0 >= config.max_top5_hold_pct:
        return "top5_concentration"
    return None


def metrics_component(analysis: Analysis) -> float:
    """The code-computed 0..1 term in the scoring matrix.

    Deliberately built only from things measured on-chain, so that it stays
    an independent vote against the three model-derived components rather
    than a fourth restatement of them.
    """
    risk_inverse = max(0.0, 1.0 - analysis.risk_score / 10.0)
    sniper_penalty = max(0.0, 1.0 - analysis.sniper_count / 10.0)
    value = (
        0.35 * risk_inverse
        + 0.25 * analysis.curve_health
        + 0.20 * analysis.wallet_diversity
        + 0.10 * analysis.social_signal
        + 0.10 * sniper_penalty
    )
    return max(0.0, min(1.0, value))


# -- payload helpers -------------------------------------------------------


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("holders", "trades", "data", "items", "results"):
            inner = value.get(key)
            if isinstance(inner, list):
                return inner
    return []


def _str(data: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _num(data: Any, *keys: str) -> float:
    if not isinstance(data, dict):
        return 0.0
    for key in keys:
        value = data.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return 0.0


def _truthy(data: dict[str, Any], *keys: str) -> bool:
    return any(bool(data.get(key)) for key in keys)


def _pct(holder: dict[str, Any]) -> float:
    """A holder's share of supply, normalised to percent.

    Providers report this as either a percent (0..100) or a fraction
    (0..1). A value at or below 1 is read as a fraction -- which makes a
    genuine 1%-or-less holder read as a fraction too, but that error is
    negligible and errs toward under-counting a small holder rather than
    inflating a large one into a false veto.
    """
    value = _num(holder, "percentage", "percent", "pct", "share")
    if value <= 1.0:
        return value * 100.0
    return value


def _first_pool(detail: dict[str, Any]) -> dict[str, Any]:
    pools = detail.get("pools")
    if isinstance(pools, list) and pools and isinstance(pools[0], dict):
        return pools[0]
    return {}


def _risk_score(detail: dict[str, Any], token: Token) -> float:
    risk = detail.get("risk")
    if isinstance(risk, dict):
        value = _num(risk, "score")
        if value:
            return value
    value = _num(detail, "riskScore", "risk_score")
    return value or token.risk_score
