"""Stage 9: execution.

Two executors behind one interface.

``DryRunExecutor`` walks the whole path and stops short of signing. It
still reads real prices, so PnL and every exit rule are evaluated against
the real market -- a dry run that used made-up prices would tell you
nothing about whether your exits work.

``LiveExecutor`` signs and sends. It spends real SOL, and the safeguards
around it are not decoration:

* an explicit per-transaction spend ceiling, independent of the risk
  manager, so a bug in scoring cannot produce an unbounded order;
* a slippage bound on every buy, enforced by the program itself;
* simulation before send, so a malformed transaction fails for free;
* confirmation polling that raises on an on-chain error, so a failed
  transaction is never recorded as a filled position;
* the token amount taken from the *balance delta*, not the quote, so the
  position reflects what was actually received.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from typing import Any

import httpx
from pydantic import BaseModel

from .models import Config, Position, Token

log = logging.getLogger(__name__)

TOTAL_SUPPLY = 1_000_000_000.0
LAMPORTS_PER_SOL = 1_000_000_000
TOKEN_UNITS = 1_000_000
DRY_RUN_TX = "dry_run"


class ExecutionResult(BaseModel):
    """The outcome of one attempt."""

    ok: bool
    tx_hash: str = ""
    price: float = 0.0
    token_amount: float = 0.0
    sol_amount: float = 0.0
    error: str = ""


class BaseExecutor:
    """Shared price reading. Both modes quote from the same source."""

    def __init__(self, config: Config, client: httpx.AsyncClient | None = None) -> None:
        self.config = config
        self._client = client
        self._owns_client = client is None

    async def __aenter__(self) -> BaseExecutor:
        if self._client is None:
            headers = {}
            if self.config.data.api_key.get_secret_value():
                headers["x-api-key"] = self.config.data.api_key.get_secret_value()
            self._client = httpx.AsyncClient(
                base_url=self.config.data.rest_url,
                headers=headers,
                timeout=self.config.data.request_timeout,
            )
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def price(self, mint: str) -> float:
        """Price of one token in SOL, or 0.0 if unknown."""
        if self._client is None:
            return 0.0
        try:
            response = await self._client.get(f"/tokens/{mint}")
            response.raise_for_status()
            return price_from_payload(response.json())
        except Exception as exc:
            log.warning("price unavailable for %s: %s", mint[:8], exc)
            return 0.0

    async def buy(self, token: Token, size_sol: float) -> ExecutionResult:
        raise NotImplementedError

    async def sell(self, position: Position) -> ExecutionResult:
        raise NotImplementedError

    async def close(self) -> None:
        await self.__aexit__()


def price_from_payload(data: dict[str, Any]) -> float:
    """SOL per token from provider payloads, in order of trustworthiness."""
    reserves_sol = _num(data, "virtual_sol_reserves", "virtualSolReserves")
    reserves_token = _num(data, "virtual_token_reserves", "virtualTokenReserves")
    if reserves_sol and reserves_token:
        return (reserves_sol / LAMPORTS_PER_SOL) / (reserves_token / TOKEN_UNITS)

    pools = data.get("pools")
    if isinstance(pools, list) and pools and isinstance(pools[0], dict):
        price = _num(pools[0].get("price", {}), "quote")
        if price:
            return price

    market_cap_sol = _num(data, "market_cap_sol", "marketCapSol")
    if market_cap_sol:
        return market_cap_sol / TOTAL_SUPPLY
    return 0.0


def _num(data: Any, *keys: str) -> float:
    if not isinstance(data, dict):
        return 0.0
    for key in keys:
        value = data.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value)
            except ValueError:
                continue
    return 0.0


class DryRunExecutor(BaseExecutor):
    """Everything except the signature."""

    async def buy(self, token: Token, size_sol: float) -> ExecutionResult:
        price = await self.price(token.mint)
        if price <= 0 and token.market_cap_sol:
            price = token.market_cap_sol / TOTAL_SUPPLY
        if price <= 0:
            # A position opened at a price of zero is unmanageable: no exit
            # rule can evaluate against it, so it would hang open forever.
            # Refusing the trade is the only correct outcome.
            log.warning("buy of %s abandoned: entry price unknown", token.short)
            return ExecutionResult(ok=False, error="entry price unknown")

        log.info("[dry-run] buy %s for %.4f SOL at %.12f", token.short, size_sol, price)
        return ExecutionResult(
            ok=True, tx_hash=DRY_RUN_TX, price=price,
            token_amount=size_sol / price, sol_amount=size_sol,
        )

    async def sell(self, position: Position) -> ExecutionResult:
        price = await self.price(position.mint)
        proceeds = position.token_amount * price if price > 0 else 0.0
        log.info("[dry-run] sell %s at %.12f for %.4f SOL",
                 position.mint[:8], price, proceeds)
        return ExecutionResult(
            ok=True, tx_hash=DRY_RUN_TX, price=price,
            token_amount=position.token_amount, sol_amount=proceeds,
        )


class LiveExecutor(BaseExecutor):
    """Signs and sends real transactions.

    Imports of ``solders`` and the chain modules are deferred to
    construction so that a dry-run deployment does not need them installed.
    """

    def __init__(self, config: Config, client: httpx.AsyncClient | None = None,
                 rpc: Any = None) -> None:
        super().__init__(config, client)

        from solders.keypair import Keypair  # noqa: PLC0415

        from .chain import pumpfun  # noqa: PLC0415
        from .chain.rpc import SolanaRpc  # noqa: PLC0415

        self._pumpfun = pumpfun
        self.keypair: Keypair = load_keypair(
            config.solana.wallet_private_key.get_secret_value()
        )
        self.pubkey = self.keypair.pubkey()
        self.rpc = rpc if rpc is not None else SolanaRpc(config.solana.rpc_url)
        self._fee_recipient: Any = None
        log.warning("LIVE mode: wallet %s will sign transactions", str(self.pubkey))

    async def __aenter__(self) -> LiveExecutor:
        await super().__aenter__()
        await self.rpc.__aenter__()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.rpc.__aexit__(*exc)
        await super().__aexit__(*exc)

    # -- chain reads -------------------------------------------------------

    async def fee_recipient(self) -> Any:
        """Cached read of the program's current fee recipient.

        Read from the global account rather than hardcoded: it has been
        rotated before, and a stale value fails every transaction.
        """
        if self._fee_recipient is None:
            data = await self.rpc.account_data(str(self._pumpfun.global_pda()))
            if not data:
                raise RuntimeError("pump.fun global account not found")
            self._fee_recipient = self._pumpfun.parse_fee_recipient(data)
        return self._fee_recipient

    async def curve(self, mint: str) -> Any:
        from solders.pubkey import Pubkey  # noqa: PLC0415

        address = self._pumpfun.bonding_curve_pda(Pubkey.from_string(mint))
        data = await self.rpc.account_data(str(address))
        if not data:
            raise RuntimeError(f"no bonding curve for {mint[:8]}: not a pump.fun token")
        return self._pumpfun.BondingCurve.parse(data)

    async def price(self, mint: str) -> float:
        """Price straight off the curve, falling back to the provider.

        On-chain first because it is the price the trade will actually
        execute against, and because a stop-loss driven by a lagging
        provider quote sells at the wrong moment.
        """
        try:
            curve = await self.curve(mint)
            if not curve.complete:
                spot = curve.price_sol_per_token
                if spot > 0:
                    return spot
        except Exception as exc:
            log.debug("on-chain price unavailable for %s: %s", mint[:8], exc)
        return await super().price(mint)

    # -- trading -----------------------------------------------------------

    async def buy(self, token: Token, size_sol: float) -> ExecutionResult:
        cap = self.config.solana.max_wallet_spend_sol
        if size_sol <= 0:
            return ExecutionResult(ok=False, error="non-positive size")
        if size_sol > cap:
            # Independent of the risk manager on purpose: this is the last
            # ceiling, and it must hold even if scoring or sizing is wrong.
            log.error("buy of %.4f SOL exceeds max_wallet_spend_sol %.4f", size_sol, cap)
            return ExecutionResult(ok=False, error="exceeds max_wallet_spend_sol")

        try:
            return await self._buy(token, size_sol)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.error("live buy of %s failed: %s", token.short, exc)
            return ExecutionResult(ok=False, error=str(exc))

    async def _buy(self, token: Token, size_sol: float) -> ExecutionResult:
        from solders.pubkey import Pubkey  # noqa: PLC0415

        pf = self._pumpfun
        mint = Pubkey.from_string(token.mint)
        lamports = int(size_sol * LAMPORTS_PER_SOL)

        curve = await self.curve(token.mint)
        if curve.complete:
            # Past graduation the curve no longer trades; the token moved to
            # a DEX and needs a swap route instead of a curve instruction.
            return ExecutionResult(ok=False, error="curve complete (graduated)")

        balance = await self.rpc.balance_lamports(str(self.pubkey))
        # Headroom for fees, rent on the token account, and the tip.
        needed = lamports + 10_000_000 + self.config.solana.jito.tip_lamports
        if balance < needed:
            return ExecutionResult(
                ok=False,
                error=f"insufficient balance: {balance/1e9:.4f} SOL, need ~{needed/1e9:.4f}",
            )

        expected_tokens = curve.tokens_out(lamports)
        if expected_tokens <= 0:
            return ExecutionResult(ok=False, error="curve quoted zero tokens")

        max_sol_cost = pf.apply_slippage_up(lamports, self.config.solana.slippage_bps)

        creator = curve.creator
        if creator is None:
            if not token.creator:
                return ExecutionResult(
                    ok=False, error="creator unknown; cannot derive creator vault"
                )
            creator = Pubkey.from_string(token.creator)

        accounts = pf.TradeAccounts.build(
            user=self.pubkey, mint=mint, creator=creator,
            fee_recipient=await self.fee_recipient(),
        )

        instructions = [
            *self._budget_instructions(),
            pf.create_ata_idempotent_instruction(self.pubkey, self.pubkey, mint),
            pf.buy_instruction(accounts, expected_tokens, max_sol_cost),
        ]

        before = await self.rpc.token_balance(str(accounts.associated_user))
        signature = await self._send(instructions, seed=hash(token.mint))
        after = await self._settled_token_balance(str(accounts.associated_user), before)

        received = max(0, after - before)
        if received <= 0:
            # The transaction confirmed but no tokens arrived. Reporting a
            # fill here would create a phantom position the exit loop would
            # then try to sell.
            return ExecutionResult(
                ok=False, tx_hash=signature,
                error="transaction confirmed but token balance did not increase",
            )

        token_amount = received / TOKEN_UNITS
        fill_price = size_sol / token_amount
        log.info("bought %.4f SOL of %s at %.12f (%s)",
                 size_sol, token.short, fill_price, signature)
        return ExecutionResult(
            ok=True, tx_hash=signature, price=fill_price,
            token_amount=token_amount, sol_amount=size_sol,
        )

    async def sell(self, position: Position) -> ExecutionResult:
        try:
            return await self._sell(position)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.error("live sell of %s failed: %s", position.mint[:8], exc)
            return ExecutionResult(ok=False, error=str(exc))

    async def _sell(self, position: Position) -> ExecutionResult:
        from solders.pubkey import Pubkey  # noqa: PLC0415

        pf = self._pumpfun
        mint = Pubkey.from_string(position.mint)

        curve = await self.curve(position.mint)
        if curve.complete:
            return ExecutionResult(ok=False, error="curve complete (graduated)")

        creator = curve.creator
        if creator is None:
            if not position.creator:
                return ExecutionResult(ok=False, error="creator unknown")
            creator = Pubkey.from_string(position.creator)

        accounts = pf.TradeAccounts.build(
            user=self.pubkey, mint=mint, creator=creator,
            fee_recipient=await self.fee_recipient(),
        )

        # Sell what the wallet actually holds, not what the position record
        # believes it holds: the two diverge after a partial fill, and
        # over-selling simply fails the whole transaction.
        held = await self.rpc.token_balance(str(accounts.associated_user))
        if held <= 0:
            return ExecutionResult(ok=False, error="no token balance to sell")

        quoted = curve.sol_out(held)
        min_sol_output = pf.apply_slippage_down(quoted, self.config.solana.slippage_bps)

        instructions = [
            *self._budget_instructions(),
            pf.sell_instruction(accounts, held, min_sol_output),
        ]

        before = await self.rpc.balance_lamports(str(self.pubkey))
        signature = await self._send(instructions, seed=hash(position.mint))
        after = await self.rpc.balance_lamports(str(self.pubkey))

        proceeds = max(0, after - before) / LAMPORTS_PER_SOL
        token_amount = held / TOKEN_UNITS
        price = proceeds / token_amount if token_amount else 0.0
        log.info("sold %s for %.4f SOL (%s)", position.mint[:8], proceeds, signature)
        return ExecutionResult(
            ok=True, tx_hash=signature, price=price,
            token_amount=token_amount, sol_amount=proceeds,
        )

    # -- transaction plumbing ---------------------------------------------

    def _budget_instructions(self) -> list[Any]:
        from solders.compute_budget import (  # noqa: PLC0415
            set_compute_unit_limit,
            set_compute_unit_price,
        )

        return [
            set_compute_unit_limit(self.config.solana.compute_unit_limit),
            set_compute_unit_price(self.config.solana.priority_fee_microlamports),
        ]

    async def _send(self, instructions: list[Any], seed: int) -> str:
        """Sign, simulate, submit, and confirm. Returns the signature."""
        from solders.message import MessageV0  # noqa: PLC0415
        from solders.transaction import VersionedTransaction  # noqa: PLC0415

        solana = self.config.solana
        if solana.jito.enabled and solana.jito.tip_lamports > 0:
            instructions = [*instructions, self._tip_instruction(seed)]

        blockhash_str, _ = await self.rpc.latest_blockhash()
        from solders.hash import Hash  # noqa: PLC0415

        message = MessageV0.try_compile(
            payer=self.pubkey,
            instructions=instructions,
            address_lookup_table_accounts=[],
            recent_blockhash=Hash.from_string(blockhash_str),
        )
        transaction = VersionedTransaction(message, [self.keypair])
        encoded = base64.b64encode(bytes(transaction)).decode("ascii")

        if solana.simulate_before_send:
            simulation = await self.rpc.simulate(encoded)
            if simulation.get("err") is not None:
                logs = simulation.get("logs") or []
                tail = "; ".join(str(line) for line in logs[-4:])
                raise RuntimeError(f"simulation failed: {simulation['err']} :: {tail}")

        signature = str(transaction.signatures[0])

        if solana.jito.enabled:
            from .chain.jito import JitoClient  # noqa: PLC0415

            async with JitoClient(solana.jito.block_engine_url) as jito:
                bundle = await jito.send_bundle([encoded])
                log.info("submitted jito bundle %s", bundle)
        else:
            sent = await self.rpc.send(encoded)
            if sent != signature:  # pragma: no cover - defensive
                log.warning("rpc returned signature %s, expected %s", sent, signature)
                signature = sent

        await self.rpc.confirm(signature, timeout=solana.confirm_timeout_seconds)
        return signature

    def _tip_instruction(self, seed: int) -> Any:
        from solders.system_program import TransferParams, transfer  # noqa: PLC0415

        from .chain.jito import tip_account  # noqa: PLC0415

        return transfer(TransferParams(
            from_pubkey=self.pubkey,
            to_pubkey=tip_account(seed),
            lamports=self.config.solana.jito.tip_lamports,
        ))

    async def _settled_token_balance(self, ata: str, before: int,
                                     attempts: int = 5) -> int:
        """Re-read the token balance until it moves off its prior value.

        A confirmed transaction is not instantly visible to every RPC node,
        so reading once can return the pre-trade balance and make a good
        fill look like a failure.
        """
        balance = before
        for _ in range(attempts):
            balance = await self.rpc.token_balance(ata)
            if balance != before:
                return balance
            await asyncio.sleep(0.4)
        return balance


def load_keypair(secret: str) -> Any:
    """Load a wallet key from base58 or a JSON byte array.

    Both are what wallets actually export. Errors deliberately say nothing
    about the value itself -- an exception carrying key material would end
    up in logs.
    """
    from solders.keypair import Keypair  # noqa: PLC0415

    secret = secret.strip()
    if not secret:
        raise ValueError("wallet private key is empty")

    if secret.startswith("["):
        import json  # noqa: PLC0415

        try:
            numbers = json.loads(secret)
            return Keypair.from_bytes(bytes(numbers))
        except Exception as exc:
            raise ValueError(f"wallet key is not a valid JSON byte array ({type(exc).__name__})") from None

    try:
        return Keypair.from_base58_string(secret)
    except Exception as exc:
        raise ValueError(f"wallet key is not valid base58 ({type(exc).__name__})") from None


def build_executor(config: Config, client: httpx.AsyncClient | None = None) -> BaseExecutor:
    if config.is_live:
        return LiveExecutor(config, client)
    return DryRunExecutor(config, client)


def new_position(token: Token, result: ExecutionResult, score: float) -> Position:
    return Position(
        mint=token.mint,
        symbol=token.symbol,
        creator=token.creator,
        entry_price=result.price,
        peak_price=result.price,
        sol_spent=result.sol_amount,
        token_amount=result.token_amount,
        opened_at=time.time(),
        tx_hash=result.tx_hash,
        score=score,
    )
