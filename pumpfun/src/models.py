"""Domain models and validated configuration.

Two rules shape this module:

* **Secrets are ``SecretStr``.** They never appear in ``repr``, in a model
  dump, or in a traceback. ``Config.masked()`` is the only way to print one.
* **A bad config fails at startup, not an hour into trading.** Every limit
  that could silently disable a brake is validated here.
"""

from __future__ import annotations

import os
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
    model_validator,
)

ENV_PREFIX = "PUMPBOT_"

# Placeholders shipped in config.example.yaml. Starting with one of these
# still in place is a config error, not a runtime surprise.
PLACEHOLDERS = {
    "xai-your-key-here",
    "your-data-provider-key",
    "your-wallet-private-key",
    "changeme",
    "",
}


# --------------------------------------------------------------------------
# Domain models
# --------------------------------------------------------------------------


class Token(BaseModel):
    """A launch as it comes off the WebSocket stream."""

    mint: str
    name: str = ""
    symbol: str = ""
    description: str = ""
    image_url: str = ""
    twitter: str = ""
    telegram: str = ""
    website: str = ""
    creator: str = ""

    bonding_curve_pct: float = 0.0
    unique_buyers: int = 0
    volume_sol: float = 0.0
    market_cap_sol: float = 0.0
    age_minutes: float = 0.0
    risk_score: float = 5.0

    seen_at: float = Field(default_factory=time.time)

    @property
    def has_metadata(self) -> bool:
        return bool(self.name and self.image_url)

    @property
    def short(self) -> str:
        return f"{self.symbol or '?'}:{self.mint[:8]}"

    @classmethod
    def from_ws(cls, data: dict[str, Any]) -> Token:
        """Build from a provider WebSocket frame.

        Providers disagree on field names, so each value is read through a
        list of aliases. A frame with no mint is unusable and rejected by
        the caller.
        """
        return cls(
            mint=_first_str(data, "mint", "address", "tokenAddress", "token"),
            name=_first_str(data, "name", "tokenName"),
            symbol=_first_str(data, "symbol", "ticker"),
            description=_first_str(data, "description", "desc"),
            image_url=_first_str(data, "image", "image_uri", "imageUrl", "uri"),
            twitter=_first_str(data, "twitter", "twitterUrl"),
            telegram=_first_str(data, "telegram", "telegramUrl"),
            website=_first_str(data, "website", "websiteUrl"),
            creator=_first_str(data, "creator", "dev", "deployer", "traderPublicKey"),
            bonding_curve_pct=_first_float(data, "progress", "bondingCurvePct", "curvePercent"),
            unique_buyers=int(_first_float(data, "uniqueHolders", "holders", "buyers")),
            volume_sol=_first_float(data, "volumeSOL", "volume_sol", "vSolInBondingCurve"),
            market_cap_sol=_first_float(data, "marketCapSol", "market_cap_sol"),
            age_minutes=_first_float(data, "ageMinutes", "age_minutes"),
            risk_score=_first_float(data, "riskScore", "risk_score", default=5.0),
        )


def _first_str(data: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _first_float(data: dict[str, Any], *keys: str, default: float = 0.0) -> float:
    for key in keys:
        value = data.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value)
            except ValueError:
                continue
    return default


class Analysis(BaseModel):
    """Metric-level view of a token, assembled from REST endpoints."""

    risk_score: float = 5.0
    sniper_count: int = 0
    insider_pct: float = 0.0
    creator_pct: float = 0.0
    curve_health: float = 0.0
    social_signal: float = 0.0
    wallet_diversity: float = 0.0
    volume_sol: float = 0.0
    market_cap_usd: float = 0.0
    holder_count: int = 0

    trades: list[dict[str, Any]] = Field(default_factory=list)
    holders: list[dict[str, Any]] = Field(default_factory=list)

    def summary(self) -> dict[str, float]:
        """The numeric part only -- what goes into logs and prompts."""
        return {
            "risk_score": self.risk_score,
            "sniper_count": float(self.sniper_count),
            "insider_pct": self.insider_pct,
            "creator_pct": self.creator_pct,
            "curve_health": self.curve_health,
            "social_signal": self.social_signal,
            "wallet_diversity": self.wallet_diversity,
        }


class AuditResult(BaseModel):
    """Wallet-behaviour verdict from the auditor agent."""

    coordinated_buys: bool = True
    wash_trading: bool = True
    creator_dump_risk: float = 1.0
    organic_score: float = 0.0
    notes: str = ""

    @classmethod
    def pessimistic(cls, reason: str = "agent failure") -> AuditResult:
        """Every flag raised. What a broken or unparseable call returns."""
        return cls(
            coordinated_buys=True,
            wash_trading=True,
            creator_dump_risk=1.0,
            organic_score=0.0,
            notes=reason,
        )

    @property
    def component(self) -> float:
        """0..1 contribution to the scoring matrix."""
        score = self.organic_score * (1.0 - self.creator_dump_risk)
        if self.coordinated_buys:
            score *= 0.4
        if self.wash_trading:
            score *= 0.4
        return _clamp(score)


class NarrativeResult(BaseModel):
    """Meme-potential verdict."""

    narrative_fit: float = 0.0
    virality: float = 0.0
    community: float = 0.0
    timing: float = 0.0
    notes: str = ""

    @classmethod
    def pessimistic(cls, reason: str = "agent failure") -> NarrativeResult:
        return cls(notes=reason)

    @property
    def component(self) -> float:
        return _clamp(
            0.35 * self.narrative_fit
            + 0.30 * self.virality
            + 0.20 * self.community
            + 0.15 * self.timing
        )


class TimingResult(BaseModel):
    """Market-regime verdict. Cached across tokens."""

    market_mood: float = 0.0
    meme_season: float = 0.0
    volume_signal: float = 0.0
    timing_score: float = 0.0
    notes: str = ""
    computed_at: float = Field(default_factory=time.time)

    @classmethod
    def pessimistic(cls, reason: str = "agent failure") -> TimingResult:
        # Deliberately not zero: timing is a backdrop shared by every token,
        # so a failed call must not permanently zero the whole pipeline the
        # way a per-token zero would. It biases against trading instead.
        return cls(
            market_mood=0.3,
            meme_season=0.3,
            volume_signal=0.3,
            timing_score=0.3,
            notes=reason,
        )

    @property
    def component(self) -> float:
        return _clamp(
            0.4 * self.timing_score
            + 0.3 * self.meme_season
            + 0.2 * self.market_mood
            + 0.1 * self.volume_signal
        )


class CheckerResult(BaseModel):
    """Adversarial verdict. ``approve=False`` is a normal outcome."""

    approve: bool = False
    confidence: float = 0.0
    risk_flags: list[str] = Field(default_factory=list)
    reason: str = ""

    @classmethod
    def pessimistic(cls, reason: str = "checker failed to respond") -> CheckerResult:
        return cls(approve=False, confidence=0.0, risk_flags=["agent_error"], reason=reason)


class ScoreBreakdown(BaseModel):
    """Every component that produced a total, kept for the log.

    Storing components rather than just the total is what lets
    ``scripts/tune.py`` re-score history under different weights without
    calling a single agent again.
    """

    audit: float = 0.0
    narrative: float = 0.0
    timing: float = 0.0
    metrics: float = 0.0
    total: float = 0.0

    @property
    def weakest(self) -> str:
        parts = {
            "audit": self.audit,
            "narrative": self.narrative,
            "timing": self.timing,
            "metrics": self.metrics,
        }
        return min(parts, key=lambda k: parts[k])


class Position(BaseModel):
    """An open position. Survives restart via the state file."""

    mint: str
    symbol: str = ""
    creator: str = ""
    entry_price: float
    peak_price: float = 0.0
    sol_spent: float = 0.0
    token_amount: float = 0.0
    opened_at: float = Field(default_factory=time.time)
    tx_hash: str = ""
    score: float = 0.0

    @property
    def hold_seconds(self) -> float:
        return max(0.0, time.time() - self.opened_at)

    def pnl_pct(self, price: float) -> float:
        if self.entry_price <= 0:
            return 0.0
        return (price - self.entry_price) / self.entry_price * 100.0

    def pnl_sol(self, price: float) -> float:
        return self.token_amount * price - self.sol_spent


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------


class GrokConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    api_key: SecretStr = SecretStr("")
    base_url: str = "https://api.x.ai/v1"
    fast_model: str = "grok-4-fast"
    checker_model: str = "grok-4"
    timeout_seconds: float = 30.0
    max_retries: int = Field(default=3, ge=0, le=10)


class DataConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    api_key: SecretStr = SecretStr("")
    rest_url: str = "https://data.solanatracker.io"
    ws_url: str = "wss://datastream.solanatracker.io"
    request_timeout: float = 10.0


class JitoConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    block_engine_url: str = "https://mainnet.block-engine.jito.wtf"
    tip_lamports: int = Field(default=100_000, ge=0)


class SolanaConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rpc_url: str = "https://api.mainnet-beta.solana.com"
    wallet_private_key: SecretStr = SecretStr("")

    # "local" builds the pump.fun instruction here, from constants in
    # src/chain/pumpfun.py. "remote" asks a builder service for an unsigned
    # transaction and signs it locally -- the key never leaves this process
    # either way. See docs in src/chain/pumpfun.py for the trade-off.
    builder: Literal["local", "remote"] = "local"
    remote_builder_url: str = "https://pumpportal.fun/api/trade-local"

    slippage_bps: int = Field(default=1000, ge=0, le=10_000)
    priority_fee_microlamports: int = Field(default=200_000, ge=0)
    compute_unit_limit: int = Field(default=250_000, ge=0, le=1_400_000)
    confirm_timeout_seconds: float = Field(default=45.0, gt=0)
    simulate_before_send: bool = True
    max_wallet_spend_sol: float = Field(default=1.0, ge=0)

    jito: JitoConfig = Field(default_factory=JitoConfig)


class FilterConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    min_unique_buyers: int = Field(default=5, ge=0)
    max_curve_pct: float = Field(default=40.0, gt=0, le=100)
    min_age_minutes: float = Field(default=2.0, ge=0)
    require_metadata: bool = True
    max_risk_score: float = Field(default=7.0, ge=0, le=10)
    max_creator_hold_pct: float = Field(default=25.0, gt=0, le=100)
    max_top5_hold_pct: float = Field(default=80.0, gt=0, le=100)
    min_total_score: float = Field(default=0.6, ge=0.0, le=1.0)


class ScoringWeights(BaseModel):
    model_config = ConfigDict(extra="forbid")

    audit: float = Field(default=0.30, ge=0)
    narrative: float = Field(default=0.25, ge=0)
    timing: float = Field(default=0.15, ge=0)
    metrics: float = Field(default=0.30, ge=0)

    @model_validator(mode="after")
    def _at_least_one_positive(self) -> ScoringWeights:
        if self.audit + self.narrative + self.timing + self.metrics <= 0:
            raise ValueError("scoring weights sum to zero: every token would score 0")
        return self

    def normalized(self) -> dict[str, float]:
        """Weights rescaled to sum to 1, so totals stay in 0..1."""
        total = self.audit + self.narrative + self.timing + self.metrics
        return {
            "audit": self.audit / total,
            "narrative": self.narrative / total,
            "timing": self.timing / total,
            "metrics": self.metrics / total,
        }


class ScoringConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    weights: ScoringWeights = Field(default_factory=ScoringWeights)
    timing_cache_seconds: float = Field(default=900.0, ge=0)


class RiskConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_sol_per_trade: float = Field(default=0.05, gt=0)
    daily_loss_limit_sol: float = Field(default=0.5, gt=0)
    max_trades_per_day: int = Field(default=10, gt=0)
    max_open_positions: int = Field(default=3, gt=0)

    # Exit rules. Zero disables the individual rule.
    stop_loss_pct: float = Field(default=50.0, ge=0, le=100)
    take_profit_pct: float = Field(default=100.0, ge=0)
    trailing_stop_pct: float = Field(default=30.0, ge=0, le=100)
    max_hold_seconds: float = Field(default=3600.0, ge=0)
    stop_loss_poll_seconds: float = Field(default=5.0, gt=0)

    @model_validator(mode="after")
    def _some_exit_exists(self) -> RiskConfig:
        if not (self.stop_loss_pct or self.take_profit_pct
                or self.trailing_stop_pct or self.max_hold_seconds):
            raise ValueError(
                "all four exit rules are disabled: positions would never close"
            )
        return self


class ReputationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    rug_loss_pct: float = Field(default=60.0, gt=0, le=100)
    block_creator_after_rugs: int = Field(default=2, gt=0)
    one_position_per_creator: bool = True
    forget_creators_after_days: float = Field(default=30.0, ge=0)
    path: str = "state/creators.json"


class OpsConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    grok_rate_limit_per_minute: int = Field(default=60, ge=0)
    grok_daily_call_budget: int = Field(default=2000, ge=0)
    breaker_failures: int = Field(default=5, gt=0)
    breaker_cooldown_seconds: float = Field(default=300.0, gt=0)
    health_port: int = Field(default=0, ge=0, le=65535)
    heartbeat_seconds: float = Field(default=60.0, gt=0)
    shutdown_grace_seconds: float = Field(default=20.0, ge=0)


class AlertsConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    webhook_url: SecretStr = SecretStr("")
    min_interval_seconds: float = Field(default=5.0, ge=0)


class LoggingConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = "logs/trades.jsonl"
    level: str = "INFO"
    max_bytes: int = Field(default=50 * 1024 * 1024, gt=0)
    backups: int = Field(default=5, ge=0)

    @field_validator("level")
    @classmethod
    def _known_level(cls, value: str) -> str:
        allowed = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        upper = value.upper()
        if upper not in allowed:
            raise ValueError(f"level must be one of {sorted(allowed)}")
        return upper


class StateConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = "state/pipeline.json"


class Config(BaseModel):
    """Top-level configuration."""

    model_config = ConfigDict(extra="forbid")

    mode: Literal["dry-run", "live"] = "dry-run"

    grok: GrokConfig = Field(default_factory=GrokConfig)
    data: DataConfig = Field(default_factory=DataConfig)
    solana: SolanaConfig = Field(default_factory=SolanaConfig)
    filter: FilterConfig = Field(default_factory=FilterConfig)
    scoring: ScoringConfig = Field(default_factory=ScoringConfig)
    risk: RiskConfig = Field(default_factory=RiskConfig)
    reputation: ReputationConfig = Field(default_factory=ReputationConfig)
    ops: OpsConfig = Field(default_factory=OpsConfig)
    alerts: AlertsConfig = Field(default_factory=AlertsConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
    state: StateConfig = Field(default_factory=StateConfig)

    @property
    def is_live(self) -> bool:
        return self.mode == "live"

    # -- loading -----------------------------------------------------------

    @classmethod
    def load(cls, path: str | Path | None = None,
             environ: Mapping[str, str] | None = None) -> Config:
        """Read YAML, then let environment variables win over it.

        An empty environment variable does not erase a file value -- that
        mistake is common enough in compose files to be worth guarding.
        """
        raw: dict[str, Any] = {}
        if path is not None:
            text = Path(path).read_text(encoding="utf-8")
            loaded = yaml.safe_load(text)
            if loaded is not None:
                if not isinstance(loaded, dict):
                    raise ValueError(f"{path}: top level must be a mapping")
                raw = loaded
        _apply_env(raw, os.environ if environ is None else environ)
        return cls.model_validate(raw)

    # -- validation --------------------------------------------------------

    def problems(self) -> list[str]:
        """Errors that must block startup."""
        found: list[str] = []
        if self.grok.api_key.get_secret_value() in PLACEHOLDERS:
            found.append("grok.api_key is unset or still a placeholder")
        if self.is_live:
            if self.solana.wallet_private_key.get_secret_value() in PLACEHOLDERS:
                found.append("mode is live but solana.wallet_private_key is unset")
            if self.solana.max_wallet_spend_sol <= 0:
                found.append("mode is live but solana.max_wallet_spend_sol is 0")
        if self.risk.max_sol_per_trade > self.risk.daily_loss_limit_sol:
            found.append(
                "risk.max_sol_per_trade exceeds risk.daily_loss_limit_sol: "
                "a single trade could blow the daily limit"
            )
        return found

    def warnings(self) -> list[str]:
        """Things worth saying out loud that do not block startup."""
        found: list[str] = []
        if self.data.api_key.get_secret_value() in PLACEHOLDERS:
            found.append("data.api_key is unset: the analyzer will run blind")
        if self.filter.min_total_score < 0.3:
            found.append(
                f"filter.min_total_score is {self.filter.min_total_score}: "
                "almost everything scored will pass"
            )
        if self.is_live and not self.solana.simulate_before_send:
            found.append(
                "solana.simulate_before_send is off: a malformed transaction "
                "will cost fees instead of failing for free"
            )
        if self.is_live and self.solana.slippage_bps >= 5000:
            found.append(
                f"solana.slippage_bps is {self.solana.slippage_bps} "
                "(>=50%): effectively unbounded slippage"
            )
        if self.reputation.enabled and self.reputation.forget_creators_after_days == 0:
            found.append("reputation.forget_creators_after_days is 0: clean addresses never expire")
        return found

    def masked(self) -> dict[str, Any]:
        """Config as a dict with every secret replaced by a marker."""
        dumped = self.model_dump(mode="json")
        _mask(dumped, self.model_dump())
        return dumped


def _mask(target: Any, source: Any) -> None:
    """Walk the dump and replace SecretStr placeholders with a marker."""
    if isinstance(source, dict) and isinstance(target, dict):
        for key, value in source.items():
            if isinstance(value, SecretStr):
                target[key] = "***set***" if value.get_secret_value() else "***unset***"
            else:
                _mask(target.get(key), value)


# Environment variable -> config path. Only the values worth overriding
# outside the file are listed; everything else lives in YAML.
ENV_MAP: dict[str, tuple[str, ...]] = {
    "MODE": ("mode",),
    "GROK_API_KEY": ("grok", "api_key"),
    "GROK_BASE_URL": ("grok", "base_url"),
    "DATA_API_KEY": ("data", "api_key"),
    "DATA_WS_URL": ("data", "ws_url"),
    "DATA_REST_URL": ("data", "rest_url"),
    "RPC_URL": ("solana", "rpc_url"),
    "WALLET_PRIVATE_KEY": ("solana", "wallet_private_key"),
    "LOG_PATH": ("logging", "path"),
    "LOG_LEVEL": ("logging", "level"),
    "STATE_PATH": ("state", "path"),
    "HEALTH_PORT": ("ops", "health_port"),
    "ALERT_WEBHOOK": ("alerts", "webhook_url"),
}


def _apply_env(raw: dict[str, Any], environ: Mapping[str, str]) -> None:
    for suffix, path in ENV_MAP.items():
        value = environ.get(ENV_PREFIX + suffix)
        # An empty value is treated as "not set" so an empty compose
        # variable cannot silently erase a real file value.
        if value is None or value == "":
            continue
        cursor = raw
        for key in path[:-1]:
            nxt = cursor.get(key)
            if not isinstance(nxt, dict):
                nxt = {}
                cursor[key] = nxt
            cursor = nxt
        cursor[path[-1]] = value
