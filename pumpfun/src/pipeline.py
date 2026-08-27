"""The orchestrator.

Nine stages, ordered so that the cheap ones run first. Of a day's launch
stream, most tokens die at stage 1 for the price of a JSON parse; a few
percent reach the model agents; and only the handful that clear the
scoring threshold ever reach the strong model in stage 7.

That ordering is the whole cost model. Reversing any two stages -- asking
the checker first, say -- would multiply the bill by a thousand and change
nothing about the decisions.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import signal
import sys
import time
from datetime import UTC, datetime
from typing import Any

import httpx

from .agents import (
    AdversarialChecker,
    GrokClient,
    MarketTimingAgent,
    NarrativeScorer,
    WalletAuditor,
)
from .alerts import Alerter
from .analyzer import AnalyzerError, TokenAnalyzer, concentration_veto
from .executor import BaseExecutor, build_executor, new_position
from .log import TradeLog
from .models import Config, Token
from .monitor import BoundedQueue, WebSocketMonitor, basic_filter
from .ops import CallLimiter, HealthServer, Metrics
from .reputation import CreatorBook
from .risk import RiskManager, check_exit, update_peak
from .scoring import compute_score
from .state import PipelineState

log = logging.getLogger(__name__)

STALL_ALERT_SECONDS = 300.0


class MarketContext:
    """Rolling statistics the timing agent is asked to interpret.

    Everything here is measured from the stream this process is already
    reading. Nothing is invented: a field with no source reports
    ``"unknown"`` and the agent is told so, rather than being handed a
    plausible-looking zero it would treat as real.
    """

    WINDOW_SECONDS = 4 * 3600.0

    def __init__(self) -> None:
        self.launches: list[tuple[float, float]] = []
        self.graduations: list[float] = []

    def record_launch(self, token: Token) -> None:
        self.launches.append((time.time(), token.volume_sol))
        self._trim()

    def record_graduation(self) -> None:
        self.graduations.append(time.time())
        self._trim()

    def _trim(self) -> None:
        cutoff = time.time() - self.WINDOW_SECONDS
        self.launches = [item for item in self.launches if item[0] >= cutoff]
        self.graduations = [item for item in self.graduations if item >= cutoff]

    def snapshot(self) -> dict[str, Any]:
        self._trim()
        volume = sum(volume for _, volume in self.launches)
        count = len(self.launches)
        return {
            "pf_volume_4h": round(volume, 2) if count else "unknown",
            "graduations_4h": len(self.graduations),
            "avg_volume_per_launch": round(volume / count, 4) if count else "unknown",
            "hour_utc": datetime.now(tz=UTC).hour,
            # No feed for these is wired up. Saying so beats sending a zero
            # the agent would read as "SOL is flat".
            "sol_24h_change": "unknown",
            "btc_dominance": "unknown",
        }


class PumpFunPipeline:
    """Wires the stages together and owns the process lifecycle."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.metrics = Metrics()
        self.limiter = CallLimiter(config.ops)
        self.trade_log = TradeLog(
            config.logging.path, config.logging.max_bytes, config.logging.backups
        )
        self.risk = RiskManager(config.risk)
        self.state = PipelineState(config.state.path)
        self.creators = CreatorBook(config.reputation)
        self.market = MarketContext()
        self.queue = BoundedQueue()
        self.monitor = WebSocketMonitor(
            config.data.ws_url, config.data.api_key.get_secret_value()
        )
        self.alerter = Alerter(
            config.alerts.webhook_url.get_secret_value(),
            config.alerts.min_interval_seconds,
            fmt=config.alerts.format,
            telegram_bot_token=config.alerts.telegram_bot_token.get_secret_value(),
            telegram_chat_id=config.alerts.telegram_chat_id,
        )

        self.grok: GrokClient | None = None
        self.analyzer: TokenAnalyzer | None = None
        self.executor: BaseExecutor | None = None
        self.auditor: WalletAuditor | None = None
        self.narrative: NarrativeScorer | None = None
        self.timing: MarketTimingAgent | None = None
        self.checker: AdversarialChecker | None = None

        self._shutdown = asyncio.Event()
        self._tasks: list[asyncio.Task[Any]] = []
        self._in_flight = 0
        self.health = HealthServer(config.ops.health_port, self.status)

    # -- lifecycle ---------------------------------------------------------

    async def setup(self) -> None:
        self.state.load()
        self.state.apply_to(self.risk)
        self.creators.load()

        grok_client = httpx.AsyncClient(
            base_url=self.config.grok.base_url,
            headers={"Authorization": f"Bearer {self.config.grok.api_key.get_secret_value()}"},
            timeout=self.config.grok.timeout_seconds,
        )
        self.grok = GrokClient(
            api_key=self.config.grok.api_key.get_secret_value(),
            base_url=self.config.grok.base_url,
            timeout=self.config.grok.timeout_seconds,
            max_retries=self.config.grok.max_retries,
            client=grok_client,
            limiter=self.limiter,
        )
        await self.grok.__aenter__()

        fast = self.config.grok.fast_model
        self.auditor = WalletAuditor(self.grok, fast)
        self.narrative = NarrativeScorer(self.grok, fast)
        self.timing = MarketTimingAgent(
            self.grok, fast, self.config.scoring.timing_cache_seconds
        )
        self.checker = AdversarialChecker(self.grok, self.config.grok.checker_model)

        self.analyzer = TokenAnalyzer(
            self.config.data.rest_url,
            self.config.data.api_key.get_secret_value(),
            self.config.data.request_timeout,
        )
        await self.analyzer.__aenter__()

        self.executor = build_executor(self.config)
        await self.executor.__aenter__()

        await self.alerter.__aenter__()
        await self.health.start()

        await self.alerter.send(
            "startup", f"pipeline up in {self.config.mode}", mode=self.config.mode
        )
        log.info("pipeline ready in %s mode", self.config.mode)

    async def teardown(self) -> None:
        """Save state first: it is the only thing that cannot be rebuilt."""
        self.state.capture(self.risk)
        self.state.save()
        self.creators.save()

        if self.state.positions:
            log.warning(
                "shutting down with %d open position(s); no exit rule runs "
                "while the process is down: %s",
                len(self.state.positions), ", ".join(self.state.positions),
            )

        await self.alerter.send(
            "shutdown", f"pipeline down, {len(self.state.positions)} position(s) open",
            open_positions=len(self.state.positions),
        )

        for closer in (self.health.stop(),):
            with contextlib.suppress(Exception):
                await closer
        for resource in (self.executor, self.analyzer, self.grok, self.alerter):
            if resource is not None:
                with contextlib.suppress(Exception):
                    await resource.__aexit__(None, None, None)

    async def run(self) -> None:
        await self.setup()
        try:
            self._tasks = [
                asyncio.create_task(self._consume_stream(), name="stream"),
                asyncio.create_task(self._process_loop(), name="process"),
                asyncio.create_task(self._exit_loop(), name="exits"),
                asyncio.create_task(self._heartbeat_loop(), name="heartbeat"),
            ]
            await self._shutdown.wait()
            await self._graceful_stop()
        finally:
            await self.teardown()

    async def _graceful_stop(self) -> None:
        """Stop taking new work, let what is in flight finish."""
        log.info("shutdown requested; draining for up to %.0fs",
                 self.config.ops.shutdown_grace_seconds)
        for task in self._tasks:
            if task.get_name() in ("stream", "heartbeat"):
                task.cancel()

        deadline = time.time() + self.config.ops.shutdown_grace_seconds
        while self._in_flight > 0 and time.time() < deadline:
            await asyncio.sleep(0.2)

        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    def request_shutdown(self, *_: Any) -> None:
        self._shutdown.set()

    # -- stage 1: the stream ----------------------------------------------

    async def _consume_stream(self) -> None:
        async for token in self.monitor.stream_launches():
            self.metrics.inc("tokens_seen")
            self.market.record_launch(token)
            if token.bonding_curve_pct >= 100:
                self.market.record_graduation()
            self.queue.put(token)
            self.metrics.set("queue_depth", len(self.queue))

    async def _process_loop(self) -> None:
        while True:
            token = await self.queue.get()
            self._in_flight += 1
            try:
                await self._evaluate(token)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.exception("evaluation of %s crashed: %s", token.short, exc)
                self.metrics.inc("evaluation_errors")
            finally:
                self._in_flight -= 1

    # -- stages 1-9 for one token -----------------------------------------

    async def _evaluate(self, token: Token) -> None:
        assert self.analyzer and self.auditor and self.narrative
        assert self.timing and self.checker and self.executor

        # Stage 1: the cheap filter.
        verdict = basic_filter(token, self.config.filter)
        if not verdict:
            self.metrics.inc(f"skip_{verdict.reason}")
            self.trade_log.skip(token, "filter", verdict.reason, verdict.detail)
            return

        # Stage 1.5: memory, before anything paid.
        if self.state.already_traded(token.mint):
            self.trade_log.skip(token, "memory", "already_traded")
            return
        if self.creators.is_blocked(token.creator):
            self.metrics.inc("skip_blocked_creator")
            self.trade_log.skip(token, "memory", "blocked_creator",
                                self.creators.rug_count(token.creator))
            return
        if self.config.reputation.one_position_per_creator and \
                self.state.creator_is_held(token.creator):
            self.trade_log.skip(token, "memory", "creator_already_held")
            return

        # Stage 2: metrics, and the vetoes no score can outvote.
        try:
            analysis = await self.analyzer.analyze(token)
        except AnalyzerError as exc:
            self.metrics.inc("skip_analyzer_error")
            self.trade_log.skip(token, "analyzer", "analyzer_error", str(exc))
            return

        veto = concentration_veto(analysis, self.config.filter)
        if veto:
            self.metrics.inc(f"skip_{veto}")
            self.trade_log.skip(token, "analyzer", veto, analysis.summary())
            return

        self.metrics.inc("reached_agents")

        # Stages 3-5: three agents at once. They are independent, so the
        # wall-clock cost is the slowest of the three, not their sum.
        audit, narrative, timing = await asyncio.gather(
            self.auditor.run(token, analysis.trades, analysis.holders),
            self.narrative.run(token, analysis),
            self.timing.evaluate(self.market.snapshot()),
        )

        # Stage 6: the matrix. Code, not a model.
        score = compute_score(analysis, audit, narrative, timing, self.config.scoring)
        self.metrics.set("last_score", score.total)

        if score.total < self.config.filter.min_total_score:
            self.metrics.inc("skip_low_score")
            self.trade_log.skip(token, "scoring", "low_score", score.weakest, score)
            return

        # Stage 7: the adversarial check, on the strong model.
        self.metrics.inc("reached_checker")
        checker = await self.checker.run(token, analysis, audit, narrative, timing, score)
        if not checker.approve:
            self.metrics.inc("skip_checker_rejected")
            self.trade_log.skip(token, "checker", "checker_rejected",
                                {"reason": checker.reason, "flags": checker.risk_flags},
                                score)
            return

        # Stage 8: the brakes.
        decision = self.risk.can_trade()
        if not decision:
            self.metrics.inc(f"skip_{decision.reason}")
            self.trade_log.skip(token, "risk", decision.reason, None, score)
            await self.alerter.on_change(
                "risk_limit", decision.reason,
                f"trading paused: {decision.reason}",
            )
            return

        size = self.risk.position_size(score.total)
        if size <= 0:
            self.trade_log.skip(token, "risk", "size_zero", None, score)
            return

        # Stage 9: execution.
        result = await self.executor.buy(token, size)
        if not result.ok:
            self.metrics.inc("execution_failed")
            self.trade_log.skip(token, "execution", "execution_failed", result.error, score)
            return

        position = new_position(token, result, score.total)
        self.state.add_position(position)
        self.risk.record_open()
        self.creators.record_trade(token.creator)
        self.state.capture(self.risk)
        self.state.save()

        self.metrics.inc("positions_opened")
        self.trade_log.buy(token, position, score, analysis, audit,
                           narrative, timing, checker, self.config.mode)
        await self.alerter.send(
            "buy", f"bought {token.short} for {size:.4f} SOL at score {score.total:.2f}",
            token=token.mint, score=score.total, size_sol=size,
        )

    # -- the exit loop -----------------------------------------------------

    async def _exit_loop(self) -> None:
        """Poll open positions and apply the four exit rules.

        This runs independently of the launch stream: a position must be
        managed whether or not new tokens are arriving.
        """
        while True:
            await asyncio.sleep(self.config.risk.stop_loss_poll_seconds)
            for mint in list(self.state.positions):
                position = self.state.positions.get(mint)
                if position is None:
                    continue
                try:
                    await self._check_position(position)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    log.exception("exit check for %s failed: %s", mint[:8], exc)

    async def _check_position(self, position: Any) -> None:
        assert self.executor is not None
        price = await self.executor.price(position.mint)
        if price <= 0:
            return

        update_peak(position, price)
        exit_signal = check_exit(position, price, self.config.risk)
        if not exit_signal:
            return

        result = await self.executor.sell(position)
        if not result.ok:
            log.error("exit of %s failed (%s); will retry next poll",
                      position.mint[:8], result.error)
            self.metrics.inc("exit_failed")
            return

        exit_price = result.price or price
        pnl_sol = result.sol_amount - position.sol_spent
        pnl_pct = position.pnl_pct(exit_price)

        self.state.remove_position(position.mint)
        self.risk.record_close(pnl_sol)
        rugged = self.creators.record_close(position.creator, pnl_pct)
        self.state.capture(self.risk)
        self.state.save()
        self.creators.save()

        self.metrics.inc("positions_closed")
        self.metrics.inc(f"exit_{exit_signal.reason}")
        self.trade_log.close(position, exit_price, pnl_sol, pnl_pct,
                             exit_signal.reason, result.tx_hash)

        await self.alerter.send(
            "close",
            f"closed {position.symbol or position.mint[:8]} "
            f"({exit_signal.reason}) {pnl_pct:+.1f}% / {pnl_sol:+.4f} SOL",
            reason=exit_signal.reason, pnl_sol=pnl_sol, pnl_pct=pnl_pct,
        )
        if rugged:
            await self.alerter.send(
                "creator_rug",
                f"creator {position.creator[:8]}... rugged us "
                f"({self.creators.rug_count(position.creator)} total)",
            )

    # -- heartbeat and health ---------------------------------------------

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(self.config.ops.heartbeat_seconds)
            payload = self.status()["health"]
            log.info("heartbeat %s", json.dumps(payload, default=str))

            await self.alerter.on_change(
                "breaker", self.limiter.breaker.is_open,
                "grok circuit breaker "
                f"{'opened' if self.limiter.breaker.is_open else 'closed'}",
            )
            stalled = payload["stream_silent_seconds"] > STALL_ALERT_SECONDS
            await self.alerter.on_change(
                "stream_stalled", stalled,
                "launch stream stalled" if stalled else "launch stream recovered",
            )

    def status(self) -> dict[str, Any]:
        silent = (
            time.time() - self.monitor.last_message_at
            if self.monitor.last_message_at else 0.0
        )
        breaker_open = self.limiter.breaker.is_open
        health = {
            "mode": self.config.mode,
            "status": "degraded" if (breaker_open or silent > STALL_ALERT_SECONDS) else "ok",
            "uptime_seconds": round(self.metrics.uptime_seconds, 1),
            "open_positions": len(self.state.positions),
            "queue_depth": len(self.queue),
            "queue_dropped": self.queue.dropped,
            "tokens_seen": self.metrics.counters.get("tokens_seen", 0),
            "reached_agents": self.metrics.counters.get("reached_agents", 0),
            "reached_checker": self.metrics.counters.get("reached_checker", 0),
            "positions_opened": self.metrics.counters.get("positions_opened", 0),
            "positions_closed": self.metrics.counters.get("positions_closed", 0),
            "today_trades": self.risk.today_trades,
            "today_net_sol": round(self.risk.today_net_sol, 4),
            "stream_silent_seconds": round(silent, 1),
            "stream_reconnects": self.monitor.reconnects,
            "creators": self.creators.snapshot(),
            **self.limiter.snapshot(),
        }
        self.metrics.set("open_positions", len(self.state.positions))
        self.metrics.set("queue_depth", len(self.queue))
        return {
            "healthy": health["status"] == "ok",
            "health": health,
            "metrics_text": self.metrics.render_prometheus(),
        }


# -- entry point -----------------------------------------------------------


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)-8s %(name)-18s %(message)s",
        stream=sys.stderr,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m src.pipeline",
        description="Agent-scored pump.fun trading pipeline.",
    )
    parser.add_argument("--config", default="config.yaml", help="path to config.yaml")
    parser.add_argument("--check", action="store_true",
                        help="validate the config, print it masked, and exit")
    parser.add_argument("--i-understand-the-risk", action="store_true",
                        help="required to start in live mode")
    return parser


async def _run(config: Config) -> int:
    pipeline = PumpFunPipeline(config)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, pipeline.request_shutdown)
    await pipeline.run()
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        config = Config.load(args.config)
    except FileNotFoundError:
        print(f"config not found: {args.config}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"config invalid: {exc}", file=sys.stderr)
        return 2

    configure_logging(config.logging.level)

    problems = config.problems()
    for warning in config.warnings():
        log.warning("config: %s", warning)
    if problems:
        for problem in problems:
            print(f"config error: {problem}", file=sys.stderr)
        return 2

    if args.check:
        print(json.dumps(config.masked(), indent=2, sort_keys=True))
        print("\nconfig is valid.")
        return 0

    if config.is_live and not args.i_understand_the_risk:
        print(
            "\nmode is 'live': this will sign transactions and spend real SOL.\n"
            "Most pump.fun tokens go to zero. The limits in this config bound\n"
            "how fast you can lose, not whether you do.\n\n"
            "Re-run with --i-understand-the-risk to start.\n",
            file=sys.stderr,
        )
        return 3

    if config.is_live:
        log.warning("=" * 62)
        log.warning("LIVE MODE -- real funds, max %.4f SOL per transaction",
                    config.solana.max_wallet_spend_sol)
        log.warning("=" * 62)

    try:
        return asyncio.run(_run(config))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
