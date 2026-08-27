"""The orchestrator, end to end, with every external call faked.

The assertions that matter most here are about *ordering*: a token
rejected at a cheap stage must never reach an expensive one. That ordering
is the entire cost model -- if a filtered token still called the checker,
the bill would be a thousand times larger for identical decisions.
"""

from __future__ import annotations

import pytest

from src.executor import ExecutionResult
from src.models import (
    Analysis,
    AuditResult,
    CheckerResult,
    Config,
    NarrativeResult,
    Position,
    TimingResult,
    Token,
)
from src.pipeline import MarketContext, PumpFunPipeline


class Recorder:
    """Counts calls so a test can assert a stage was never reached."""

    def __init__(self, result):
        self.result = result
        self.calls = 0

    async def __call__(self, *args, **kwargs):
        self.calls += 1
        return self.result


class FakeExecutor:
    def __init__(self, price=1e-8, buy_ok=True, sell_ok=True):
        self._price = price
        self.buy_ok = buy_ok
        self.sell_ok = sell_ok
        self.buys: list[tuple[str, float]] = []
        self.sells: list[str] = []

    async def price(self, mint):
        return self._price

    async def buy(self, token, size_sol):
        self.buys.append((token.mint, size_sol))
        if not self.buy_ok:
            return ExecutionResult(ok=False, error="rejected")
        return ExecutionResult(ok=True, tx_hash="sig", price=self._price,
                               token_amount=size_sol / self._price, sol_amount=size_sol)

    async def sell(self, position):
        self.sells.append(position.mint)
        if not self.sell_ok:
            return ExecutionResult(ok=False, error="rejected")
        return ExecutionResult(ok=True, tx_hash="sig", price=self._price,
                               token_amount=position.token_amount,
                               sol_amount=position.token_amount * self._price)


def build(tmp_path, **overrides) -> PumpFunPipeline:
    config = Config.model_validate({
        "mode": "dry-run",
        "grok": {"api_key": "xai-test"},
        "data": {"api_key": "d"},
        "logging": {"path": str(tmp_path / "trades.jsonl")},
        "state": {"path": str(tmp_path / "state.json")},
        "reputation": {"path": str(tmp_path / "creators.json")},
        "filter": {"min_total_score": 0.5},
        **overrides,
    })
    return PumpFunPipeline(config)


def wire(pipeline, *, analysis=None, audit=None, narrative=None,
         timing=None, checker=None, executor=None):
    """Replace every external dependency with a counting fake."""
    pipeline.analyzer = type("A", (), {})()
    pipeline.analyzer.analyze = Recorder(analysis or Analysis(
        risk_score=2.0, curve_health=0.9, wallet_diversity=0.9,
        social_signal=1.0, insider_pct=0.1, creator_pct=0.02))

    pipeline.auditor = type("Ag", (), {})()
    pipeline.auditor.run = Recorder(audit or AuditResult(
        coordinated_buys=False, wash_trading=False,
        creator_dump_risk=0.0, organic_score=1.0))

    pipeline.narrative = type("Ag", (), {})()
    pipeline.narrative.run = Recorder(narrative or NarrativeResult(
        narrative_fit=0.9, virality=0.9, community=0.9, timing=0.9))

    pipeline.timing = type("Ag", (), {})()
    pipeline.timing.evaluate = Recorder(timing or TimingResult(
        market_mood=0.8, meme_season=0.8, volume_signal=0.8, timing_score=0.8))

    pipeline.checker = type("Ag", (), {})()
    pipeline.checker.run = Recorder(checker or CheckerResult(approve=True, confidence=0.8))

    pipeline.executor = executor or FakeExecutor()
    return pipeline


@pytest.fixture
def good_token() -> Token:
    return Token(
        mint="Mint" + "A" * 40, name="Bald Cat", symbol="BALDCAT",
        image_url="i", creator="Dev" + "B" * 40,
        bonding_curve_pct=12.0, unique_buyers=25, age_minutes=6.0, risk_score=2.0,
    )


def records(pipeline):
    from src.log import read_records

    return list(read_records(pipeline.config.logging.path))


# -- the happy path --------------------------------------------------------


async def test_a_good_token_is_bought_and_recorded(tmp_path, good_token):
    pipeline = wire(build(tmp_path), executor=FakeExecutor())
    await pipeline._evaluate(good_token)

    assert pipeline.executor.buys, "expected a buy"
    assert good_token.mint in pipeline.state.positions
    assert pipeline.risk.open_positions == 1
    assert pipeline.risk.today_trades == 1

    entry = next(r for r in records(pipeline) if r["action"] == "buy")
    assert entry["symbol"] == "BALDCAT"
    assert entry["components"]["audit"] > 0


async def test_state_is_persisted_immediately_after_a_buy(tmp_path, good_token):
    pipeline = wire(build(tmp_path))
    await pipeline._evaluate(good_token)

    from src.state import PipelineState

    reloaded = PipelineState(pipeline.config.state.path)
    reloaded.load()
    assert good_token.mint in reloaded.positions, "a crash here would lose the position"


# -- stage ordering: cheap stages must short-circuit expensive ones --------


async def test_a_filtered_token_costs_nothing(tmp_path):
    pipeline = wire(build(tmp_path))
    await pipeline._evaluate(Token(mint="m", name="n", image_url="i",
                                   unique_buyers=1, age_minutes=5.0))

    assert pipeline.analyzer.analyze.calls == 0
    assert pipeline.auditor.run.calls == 0
    assert pipeline.checker.run.calls == 0
    assert records(pipeline)[0]["stage"] == "filter"


async def test_a_vetoed_token_never_reaches_an_agent(tmp_path, good_token):
    """The concentration veto exists to run before anything paid."""
    pipeline = wire(build(tmp_path), analysis=Analysis(risk_score=2.0, creator_pct=0.40))
    await pipeline._evaluate(good_token)

    assert pipeline.analyzer.analyze.calls == 1
    assert pipeline.auditor.run.calls == 0
    assert pipeline.checker.run.calls == 0
    assert records(pipeline)[0]["reason"] == "creator_concentration"


async def test_a_low_score_never_reaches_the_strong_model(tmp_path, good_token):
    pipeline = wire(
        build(tmp_path),
        audit=AuditResult.pessimistic(),
        narrative=NarrativeResult.pessimistic(),
        timing=TimingResult.pessimistic(),
        # Below the high-risk veto (7.0), so the token reaches the agents
        # and is stopped by the score rather than short-circuited earlier.
        analysis=Analysis(risk_score=6.0, curve_health=0.1, wallet_diversity=0.1),
    )
    await pipeline._evaluate(good_token)

    assert pipeline.auditor.run.calls == 1
    assert pipeline.checker.run.calls == 0, "the checker is the expensive one"
    record = records(pipeline)[0]
    assert record["reason"] == "low_score"
    assert "weakest" in record


async def test_a_blocked_creator_is_stopped_before_any_network_call(tmp_path, good_token):
    pipeline = wire(build(tmp_path))
    pipeline.creators.record_close(good_token.creator, -99.0)
    pipeline.creators.record_close(good_token.creator, -99.0)

    await pipeline._evaluate(good_token)
    assert pipeline.analyzer.analyze.calls == 0
    assert records(pipeline)[0]["reason"] == "blocked_creator"


async def test_an_already_traded_mint_is_not_re_entered(tmp_path, good_token):
    pipeline = wire(build(tmp_path))
    pipeline.state.traded_mints.add(good_token.mint)

    await pipeline._evaluate(good_token)
    assert pipeline.analyzer.analyze.calls == 0
    assert not pipeline.executor.buys


async def test_one_position_per_creator(tmp_path, good_token):
    """Two tokens from one deployer are one bet, not two."""
    pipeline = wire(build(tmp_path))
    pipeline.state.add_position(Position(mint="other", creator=good_token.creator,
                                         entry_price=1.0))
    await pipeline._evaluate(good_token)
    assert not pipeline.executor.buys
    assert records(pipeline)[0]["reason"] == "creator_already_held"


async def test_that_rule_can_be_switched_off(tmp_path, good_token):
    pipeline = wire(build(tmp_path, reputation={
        "path": str(tmp_path / "c.json"), "one_position_per_creator": False}))
    pipeline.state.add_position(Position(mint="other", creator=good_token.creator,
                                         entry_price=1.0))
    await pipeline._evaluate(good_token)
    assert pipeline.executor.buys


# -- the checker's veto ----------------------------------------------------


async def test_a_checker_rejection_stops_the_buy(tmp_path, good_token):
    pipeline = wire(build(tmp_path), checker=CheckerResult(
        approve=False, reason="organics contradict the meme score",
        risk_flags=["contradiction"]))
    await pipeline._evaluate(good_token)

    assert not pipeline.executor.buys
    record = records(pipeline)[0]
    assert record["reason"] == "checker_rejected"
    assert record["detail"]["flags"] == ["contradiction"]


async def test_a_failed_checker_stops_the_buy(tmp_path, good_token):
    """A check that could not run is a rejection, all the way through."""
    pipeline = wire(build(tmp_path), checker=CheckerResult.pessimistic())
    await pipeline._evaluate(good_token)
    assert not pipeline.executor.buys


# -- risk gating -----------------------------------------------------------


async def test_the_risk_gate_blocks_after_the_daily_loss_limit(tmp_path, good_token):
    pipeline = wire(build(tmp_path))
    pipeline.risk.today_loss_sol = 999.0

    await pipeline._evaluate(good_token)
    assert not pipeline.executor.buys
    assert records(pipeline)[0]["reason"] == "daily_loss_limit"


async def test_the_risk_gate_runs_after_the_checker_not_before(tmp_path, good_token):
    """A limit reached mid-stream should still record what the checker
    thought, so the log shows what was passed up."""
    pipeline = wire(build(tmp_path))
    pipeline.risk.open_positions = 99
    await pipeline._evaluate(good_token)
    assert pipeline.checker.run.calls == 1
    assert records(pipeline)[0]["reason"] == "max_open_positions"


async def test_a_failed_execution_opens_no_position(tmp_path, good_token):
    pipeline = wire(build(tmp_path), executor=FakeExecutor(buy_ok=False))
    await pipeline._evaluate(good_token)

    assert pipeline.state.positions == {}
    assert pipeline.risk.open_positions == 0
    assert records(pipeline)[0]["reason"] == "execution_failed"


async def test_an_analyzer_outage_skips_rather_than_guesses(tmp_path, good_token):
    from src.analyzer import AnalyzerError

    pipeline = wire(build(tmp_path))

    async def boom(*args, **kwargs):
        raise AnalyzerError("provider down")

    pipeline.analyzer.analyze = boom
    await pipeline._evaluate(good_token)
    assert not pipeline.executor.buys
    assert records(pipeline)[0]["reason"] == "analyzer_error"


# -- exits -----------------------------------------------------------------


async def test_a_stop_loss_closes_the_position_and_books_the_loss(tmp_path):
    pipeline = wire(build(tmp_path), executor=FakeExecutor(price=0.4e-8))
    position = Position(mint="m", creator="dev", entry_price=1e-8, peak_price=1e-8,
                        sol_spent=0.05, token_amount=5_000_000.0)
    pipeline.state.add_position(position)
    pipeline.risk.open_positions = 1

    await pipeline._check_position(position)

    assert pipeline.executor.sells == ["m"]
    assert "m" not in pipeline.state.positions
    assert pipeline.risk.open_positions == 0
    assert pipeline.risk.today_loss_sol > 0

    closed = next(r for r in records(pipeline) if r["action"] == "close")
    assert closed["reason"] == "stop_loss"
    assert closed["pnl_pct"] == pytest.approx(-60.0)


async def test_a_heavy_loss_is_recorded_against_the_creator(tmp_path):
    pipeline = wire(build(tmp_path), executor=FakeExecutor(price=0.1e-8))
    position = Position(mint="m", creator="dev", entry_price=1e-8, peak_price=1e-8,
                        sol_spent=0.05, token_amount=5_000_000.0)
    pipeline.state.add_position(position)
    pipeline.risk.open_positions = 1

    await pipeline._check_position(position)
    assert pipeline.creators.rug_count("dev") == 1


async def test_a_position_in_profit_is_held(tmp_path):
    pipeline = wire(build(tmp_path), executor=FakeExecutor(price=1.2e-8))
    position = Position(mint="m", entry_price=1e-8, peak_price=1e-8,
                        sol_spent=0.05, token_amount=5_000_000.0)
    pipeline.state.add_position(position)

    await pipeline._check_position(position)
    assert not pipeline.executor.sells
    assert position.peak_price == pytest.approx(1.2e-8), "peak should track up"


async def test_a_failed_sell_keeps_the_position_for_the_next_poll(tmp_path):
    """Dropping it here would leave tokens in the wallet that nothing
    manages."""
    pipeline = wire(build(tmp_path), executor=FakeExecutor(price=0.1e-8, sell_ok=False))
    position = Position(mint="m", entry_price=1e-8, peak_price=1e-8,
                        sol_spent=0.05, token_amount=5_000_000.0)
    pipeline.state.add_position(position)
    pipeline.risk.open_positions = 1

    await pipeline._check_position(position)
    assert "m" in pipeline.state.positions
    assert pipeline.risk.open_positions == 1


async def test_an_unknown_price_does_not_trigger_an_exit(tmp_path):
    pipeline = wire(build(tmp_path), executor=FakeExecutor(price=0.0))
    position = Position(mint="m", entry_price=1e-8, peak_price=1e-8, sol_spent=0.05)
    pipeline.state.add_position(position)

    await pipeline._check_position(position)
    assert not pipeline.executor.sells


# -- health and context ----------------------------------------------------


def test_status_reports_ok_when_nothing_is_wrong(tmp_path):
    pipeline = build(tmp_path)
    status = pipeline.status()
    assert status["healthy"]
    assert status["health"]["mode"] == "dry-run"
    assert "pumpbot_" in status["metrics_text"]


def test_status_degrades_when_the_breaker_opens(tmp_path):
    pipeline = build(tmp_path)
    for _ in range(pipeline.config.ops.breaker_failures):
        pipeline.limiter.record_failure()
    assert not pipeline.status()["healthy"]


def test_market_context_reports_unknown_rather_than_a_fake_zero():
    """A zero would read to the agent as 'SOL is flat', which is a claim."""
    snapshot = MarketContext().snapshot()
    assert snapshot["sol_24h_change"] == "unknown"
    assert snapshot["pf_volume_4h"] == "unknown"


def test_market_context_summarises_the_observed_stream():
    context = MarketContext()
    context.record_launch(Token(mint="a", volume_sol=2.0))
    context.record_launch(Token(mint="b", volume_sol=4.0))
    context.record_graduation()
    snapshot = context.snapshot()
    assert snapshot["pf_volume_4h"] == 6.0
    assert snapshot["avg_volume_per_launch"] == 3.0
    assert snapshot["graduations_4h"] == 1
