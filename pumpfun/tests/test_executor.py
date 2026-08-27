"""Execution, both modes. The live path runs against a fake RPC."""

from __future__ import annotations

import json
import struct

import pytest
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from src.chain.pumpfun import (
    BUY_DISCRIMINATOR,
    SELL_DISCRIMINATOR,
    bonding_curve_pda,
    global_pda,
)
from src.executor import (
    DryRunExecutor,
    LiveExecutor,
    build_executor,
    load_keypair,
    new_position,
    price_from_payload,
)
from src.models import Config, Position, Token

WALLET = Keypair()
MINT = "So11111111111111111111111111111111111111112"
BLOCKHASH = "11111111111111111111111111111111"


def live_config(**overrides) -> Config:
    solana = {
        "wallet_private_key": str(WALLET),
        "slippage_bps": 1000,
        "max_wallet_spend_sol": 1.0,
        "simulate_before_send": True,
        **overrides,
    }
    return Config.model_validate({
        "mode": "live",
        "grok": {"api_key": "xai-test"},
        "solana": solana,
    })


def curve_account(*, complete=False, v_sol=30_000_000_000,
                  v_token=1_000_000_000_000_000) -> bytes:
    return bytes(8) + struct.pack(
        "<QQQQQ?", v_token, v_sol, 800_000_000_000_000, 0,
        1_000_000_000_000_000, complete,
    ) + bytes(WALLET.pubkey())


class FakeRpc:
    """Records what the executor asked for and what it submitted."""

    def __init__(self, *, curve=None, lamports=5_000_000_000,
                 token_balances=None, simulate_err=None, confirm_err=None):
        self.curve = curve if curve is not None else curve_account()
        self.lamports = lamports
        self.token_balances = list(token_balances or [0, 3_000_000_000])
        self.simulate_err = simulate_err
        self.confirm_err = confirm_err
        self.sent: list[str] = []
        self.simulated: list[str] = []
        self.confirmed: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None

    async def account_data(self, address: str):
        if address == str(global_pda()):
            return bytes(8) + bytes([1]) + bytes(32) + bytes(WALLET.pubkey()) + bytes(64)
        if address == str(bonding_curve_pda(Pubkey.from_string(MINT))):
            return self.curve
        return None

    async def balance_lamports(self, address: str) -> int:
        return self.lamports

    async def token_balance(self, ata: str) -> int:
        if len(self.token_balances) > 1:
            return self.token_balances.pop(0)
        return self.token_balances[0]

    async def latest_blockhash(self):
        return BLOCKHASH, 100

    async def simulate(self, encoded: str):
        self.simulated.append(encoded)
        return {"err": self.simulate_err, "logs": ["Program log: whatever"]}

    async def send(self, encoded: str, skip_preflight: bool = True) -> str:
        self.sent.append(encoded)
        import base64

        from solders.transaction import VersionedTransaction

        return str(VersionedTransaction.from_bytes(base64.b64decode(encoded)).signatures[0])

    async def confirm(self, signature: str, timeout: float = 45.0):
        if self.confirm_err:
            raise RuntimeError(self.confirm_err)
        self.confirmed.append(signature)
        return {"confirmationStatus": "confirmed"}


def decode_instructions(encoded: str):
    import base64

    from solders.transaction import VersionedTransaction

    tx = VersionedTransaction.from_bytes(base64.b64decode(encoded))
    return list(tx.message.instructions)


@pytest.fixture
def token() -> Token:
    return Token(mint=MINT, name="Cat", symbol="CAT",
                 creator=str(WALLET.pubkey()), market_cap_sol=30.0)


# -- keypair loading -------------------------------------------------------


def test_keypair_loads_from_base58():
    assert load_keypair(str(WALLET)).pubkey() == WALLET.pubkey()


def test_keypair_loads_from_a_json_byte_array():
    assert load_keypair(json.dumps(list(bytes(WALLET)))).pubkey() == WALLET.pubkey()


@pytest.mark.parametrize("secret", ["", "   ", "not-base58!!", "[1,2,3]"])
def test_bad_keys_are_rejected(secret):
    with pytest.raises(ValueError):
        load_keypair(secret)


@pytest.mark.parametrize("secret", ["not-base58!!", "[1,2,3]", str(WALLET)[:20]])
def test_key_errors_never_echo_the_key_material(secret):
    """An exception carrying key material ends up in logs."""
    with pytest.raises(ValueError) as info:
        load_keypair(secret)
    assert secret not in str(info.value)


# -- price parsing ---------------------------------------------------------


def test_price_prefers_reserves_over_market_cap():
    payload = {"virtual_sol_reserves": 30_000_000_000,
               "virtual_token_reserves": 1_000_000_000_000_000,
               "market_cap_sol": 999.0}
    assert price_from_payload(payload) == pytest.approx(3e-8)


def test_price_falls_back_to_market_cap():
    assert price_from_payload({"market_cap_sol": 30.0}) == pytest.approx(3e-8)


def test_unknown_payload_prices_at_zero():
    assert price_from_payload({}) == 0.0


# -- dry run ---------------------------------------------------------------


async def test_dry_run_buy_uses_a_real_price(token, monkeypatch):
    executor = DryRunExecutor(Config())
    monkeypatch.setattr(executor, "price", lambda mint: _async(3e-8))
    result = await executor.buy(token, 0.05)
    assert result.ok
    assert result.tx_hash == "dry_run"
    assert result.token_amount == pytest.approx(0.05 / 3e-8)


async def test_dry_run_refuses_to_open_at_an_unknown_price(monkeypatch):
    """A position with no entry price is unmanageable: no exit rule can
    evaluate against it, so it would hang open forever."""
    executor = DryRunExecutor(Config())
    monkeypatch.setattr(executor, "price", lambda mint: _async(0.0))
    result = await executor.buy(Token(mint=MINT), 0.05)
    assert not result.ok
    assert "entry price" in result.error


def test_build_executor_follows_the_mode():
    assert isinstance(build_executor(Config()), DryRunExecutor)
    assert isinstance(build_executor(live_config()), LiveExecutor)


def _async(value):
    async def inner():
        return value

    return inner()


# -- live buy --------------------------------------------------------------


async def test_live_buy_signs_simulates_and_confirms(token):
    rpc = FakeRpc()
    executor = LiveExecutor(live_config(), rpc=rpc)
    result = await executor.buy(token, 0.1)

    assert result.ok
    assert rpc.simulated, "simulation must run before send"
    assert rpc.sent and rpc.confirmed
    # 3_000_000_000 base units at 6 decimals = 3000 tokens.
    assert result.token_amount == pytest.approx(3000.0)
    assert result.price == pytest.approx(0.1 / 3000.0)


async def test_live_buy_carries_a_slippage_bound(token):
    rpc = FakeRpc()
    executor = LiveExecutor(live_config(slippage_bps=1000), rpc=rpc)
    await executor.buy(token, 0.1)

    payloads = [bytes(ix.data) for ix in decode_instructions(rpc.sent[0])]
    buy = next(p for p in payloads if p[:8] == BUY_DISCRIMINATOR)
    _amount, max_sol_cost = struct.unpack("<QQ", buy[8:])
    assert max_sol_cost == pytest.approx(110_000_000, rel=1e-6)


async def test_live_buy_includes_budget_and_ata_instructions(token):
    rpc = FakeRpc()
    executor = LiveExecutor(live_config(), rpc=rpc)
    await executor.buy(token, 0.1)
    assert len(decode_instructions(rpc.sent[0])) == 4  # 2 budget + ata + buy


async def test_live_buy_refuses_to_exceed_the_hard_spend_ceiling(token):
    """Independent of the risk manager: the last ceiling must hold even if
    scoring and sizing are both wrong."""
    rpc = FakeRpc()
    executor = LiveExecutor(live_config(max_wallet_spend_sol=0.05), rpc=rpc)
    result = await executor.buy(token, 0.5)
    assert not result.ok
    assert "max_wallet_spend_sol" in result.error
    assert not rpc.sent


async def test_live_buy_refuses_a_graduated_curve(token):
    rpc = FakeRpc(curve=curve_account(complete=True))
    result = await LiveExecutor(live_config(), rpc=rpc).buy(token, 0.1)
    assert not result.ok
    assert "graduated" in result.error
    assert not rpc.sent


async def test_live_buy_refuses_when_the_wallet_cannot_cover_it(token):
    rpc = FakeRpc(lamports=1_000_000)
    result = await LiveExecutor(live_config(), rpc=rpc).buy(token, 0.5)
    assert not result.ok
    assert "insufficient balance" in result.error
    assert not rpc.sent


async def test_a_failed_simulation_stops_the_send(token):
    rpc = FakeRpc(simulate_err={"InstructionError": [3, "Custom"]})
    result = await LiveExecutor(live_config(), rpc=rpc).buy(token, 0.1)
    assert not result.ok
    assert "simulation failed" in result.error
    assert not rpc.sent, "a malformed transaction must fail for free"


async def test_a_confirmed_buy_that_delivered_nothing_is_not_a_position(token):
    """Otherwise the exit loop inherits a phantom position it cannot sell."""
    rpc = FakeRpc(token_balances=[0, 0])
    result = await LiveExecutor(live_config(), rpc=rpc).buy(token, 0.1)
    assert not result.ok
    assert "balance did not increase" in result.error


async def test_a_failed_confirmation_is_not_reported_as_filled(token):
    rpc = FakeRpc(confirm_err="transaction failed: InsufficientFunds")
    result = await LiveExecutor(live_config(), rpc=rpc).buy(token, 0.1)
    assert not result.ok


async def test_non_positive_size_is_refused(token):
    rpc = FakeRpc()
    assert not (await LiveExecutor(live_config(), rpc=rpc).buy(token, 0.0)).ok
    assert not rpc.sent


async def test_simulation_can_be_disabled(token):
    rpc = FakeRpc()
    executor = LiveExecutor(live_config(simulate_before_send=False), rpc=rpc)
    assert (await executor.buy(token, 0.1)).ok
    assert not rpc.simulated


# -- live sell -------------------------------------------------------------


async def test_live_sell_uses_the_wallet_balance_not_the_position_record():
    """The two diverge after a partial fill, and over-selling fails the
    whole transaction."""
    rpc = FakeRpc(token_balances=[7_000_000])
    position = Position(mint=MINT, creator=str(WALLET.pubkey()),
                        entry_price=1e-8, token_amount=999_999.0, sol_spent=0.1)
    result = await LiveExecutor(live_config(), rpc=rpc).sell(position)

    assert result.ok
    payloads = [bytes(ix.data) for ix in decode_instructions(rpc.sent[0])]
    sell = next(p for p in payloads if p[:8] == SELL_DISCRIMINATOR)
    amount, _min_out = struct.unpack("<QQ", sell[8:])
    assert amount == 7_000_000
    assert result.token_amount == pytest.approx(7.0)


async def test_live_sell_with_no_balance_does_not_submit():
    rpc = FakeRpc(token_balances=[0])
    position = Position(mint=MINT, creator=str(WALLET.pubkey()), entry_price=1e-8)
    result = await LiveExecutor(live_config(), rpc=rpc).sell(position)
    assert not result.ok
    assert "no token balance" in result.error
    assert not rpc.sent


async def test_live_sell_sets_a_minimum_output_from_slippage():
    rpc = FakeRpc(token_balances=[7_000_000])
    position = Position(mint=MINT, creator=str(WALLET.pubkey()), entry_price=1e-8)
    await LiveExecutor(live_config(slippage_bps=1000), rpc=rpc).sell(position)

    payloads = [bytes(ix.data) for ix in decode_instructions(rpc.sent[0])]
    sell = next(p for p in payloads if p[:8] == SELL_DISCRIMINATOR)
    _amount, min_out = struct.unpack("<QQ", sell[8:])
    assert min_out > 0


async def test_live_price_reads_the_curve_directly():
    rpc = FakeRpc()
    executor = LiveExecutor(live_config(), rpc=rpc)
    assert await executor.price(MINT) == pytest.approx(3e-8)


# -- jito ------------------------------------------------------------------


async def test_jito_adds_a_tip_transfer(token):
    rpc = FakeRpc()
    config = live_config()
    config.solana.jito.enabled = True
    config.solana.jito.tip_lamports = 100_000

    executor = LiveExecutor(config, rpc=rpc)
    sent: list[list[str]] = []

    class FakeJito:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def send_bundle(self, txs):
            sent.append(txs)
            return "bundle-1"

    import src.chain.jito as jito_module

    original = jito_module.JitoClient
    jito_module.JitoClient = FakeJito
    try:
        result = await executor.buy(token, 0.1)
    finally:
        jito_module.JitoClient = original

    assert result.ok
    assert sent, "bundle should have been submitted"
    assert len(decode_instructions(sent[0][0])) == 5  # 2 budget + ata + buy + tip


# -- position construction -------------------------------------------------


def test_new_position_seeds_peak_at_entry(token):
    from src.executor import ExecutionResult

    result = ExecutionResult(ok=True, price=2.0, token_amount=10.0, sol_amount=20.0)
    position = new_position(token, result, 0.8)
    assert position.peak_price == position.entry_price == 2.0
    assert position.creator == token.creator
