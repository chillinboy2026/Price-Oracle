"""Program constants, curve math, and instruction encoding."""

from __future__ import annotations

import struct

import pytest
from solders.pubkey import Pubkey

from src.chain.jito import TIP_ACCOUNTS, tip_account
from src.chain.pumpfun import (
    BUY_ACCOUNTS,
    BUY_DISCRIMINATOR,
    KNOWN_EVENT_AUTHORITY,
    KNOWN_GLOBAL,
    SELL_ACCOUNTS,
    SELL_DISCRIMINATOR,
    BondingCurve,
    TradeAccounts,
    apply_slippage_down,
    apply_slippage_up,
    associated_token_address,
    bonding_curve_pda,
    buy_instruction,
    create_ata_idempotent_instruction,
    discriminator,
    event_authority_pda,
    global_pda,
    parse_fee_recipient,
    self_check,
    sell_instruction,
)

MINT = Pubkey.from_string("So11111111111111111111111111111111111111112")
USER = Pubkey.from_string("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf")


# -- constants -------------------------------------------------------------


def test_derived_pdas_match_the_published_addresses():
    """Guards against a mistyped program id, which would otherwise produce
    plausible-looking addresses that no program owns."""
    assert str(global_pda()) == KNOWN_GLOBAL
    assert str(event_authority_pda()) == KNOWN_EVENT_AUTHORITY
    self_check()


def test_discriminators_follow_anchors_scheme():
    """Derived, not pasted: sha256("global:<name>")[:8]."""
    assert list(BUY_DISCRIMINATOR) == [102, 6, 61, 18, 1, 218, 235, 234]
    assert list(SELL_DISCRIMINATOR) == [51, 230, 133, 164, 1, 127, 131, 173]
    assert discriminator("buy") == BUY_DISCRIMINATOR


def test_pdas_are_deterministic():
    assert bonding_curve_pda(MINT) == bonding_curve_pda(MINT)
    assert associated_token_address(USER, MINT) == associated_token_address(USER, MINT)


# -- account state ---------------------------------------------------------


def curve_bytes(*, complete=False, creator: Pubkey | None = USER,
                v_token=1_000_000_000_000_000, v_sol=30_000_000_000,
                r_token=800_000_000_000_000) -> bytes:
    body = struct.pack("<QQQQQ?", v_token, v_sol, r_token, 0,
                       1_000_000_000_000_000, complete)
    tail = bytes(creator) if creator is not None else b""
    return bytes(8) + body + tail


def test_curve_parses_reserves_and_creator():
    curve = BondingCurve.parse(curve_bytes())
    assert curve.virtual_sol_reserves == 30_000_000_000
    assert curve.creator == USER
    assert not curve.complete


def test_curve_without_a_creator_field_still_parses():
    """Accounts predating the creator-fee change stop after the bool."""
    curve = BondingCurve.parse(curve_bytes(creator=None))
    assert curve.creator is None
    assert curve.virtual_token_reserves == 1_000_000_000_000_000


def test_all_zero_creator_reads_as_unset():
    curve = BondingCurve.parse(curve_bytes(creator=Pubkey.from_bytes(bytes(32))))
    assert curve.creator is None


def test_truncated_curve_account_is_rejected():
    with pytest.raises(ValueError, match="too short"):
        BondingCurve.parse(bytes(20))


def test_completed_curve_is_flagged():
    assert BondingCurve.parse(curve_bytes(complete=True)).complete


def test_fee_recipient_is_read_from_the_global_account():
    payload = bytes(8) + bytes([1]) + bytes(32) + bytes(USER) + bytes(64)
    assert parse_fee_recipient(payload) == USER


def test_short_global_account_is_rejected():
    with pytest.raises(ValueError, match="too short"):
        parse_fee_recipient(bytes(20))


# -- curve math ------------------------------------------------------------


def test_buy_quote_follows_the_constant_product():
    curve = BondingCurve.parse(curve_bytes())
    out = curve.tokens_out(100_000_000)  # 0.1 SOL
    k = curve.virtual_sol_reserves * curve.virtual_token_reserves
    expected = curve.virtual_token_reserves - k // (curve.virtual_sol_reserves + 100_000_000)
    assert out == expected


def test_buying_more_costs_more_per_token():
    """Price impact must be monotonic, or sizing logic is meaningless."""
    curve = BondingCurve.parse(curve_bytes())
    small = curve.tokens_out(10_000_000)
    large = curve.tokens_out(1_000_000_000)
    assert (10_000_000 / small) < (1_000_000_000 / large)


def test_buy_quote_is_capped_by_real_reserves():
    curve = BondingCurve.parse(curve_bytes(r_token=1_000))
    assert curve.tokens_out(10_000_000_000) == 1_000


def test_round_trip_returns_less_than_it_cost():
    curve = BondingCurve.parse(curve_bytes())
    spent = 100_000_000
    back = curve.sol_out(curve.tokens_out(spent))
    assert 0 < back < spent


def test_quotes_are_zero_for_non_positive_input():
    curve = BondingCurve.parse(curve_bytes())
    assert curve.tokens_out(0) == 0
    assert curve.tokens_out(-5) == 0
    assert curve.sol_out(0) == 0


def test_price_from_reserves():
    curve = BondingCurve.parse(curve_bytes())
    assert curve.price_sol_per_token == pytest.approx(3e-8)


def test_empty_curve_reports_zero_price():
    assert BondingCurve.parse(curve_bytes(v_token=0)).price_sol_per_token == 0.0


# -- slippage --------------------------------------------------------------


def test_slippage_bounds_move_in_the_protective_direction():
    assert apply_slippage_up(1_000_000, 1000) == 1_100_000
    assert apply_slippage_down(1_000_000, 1000) == 900_000


def test_slippage_down_never_goes_negative():
    assert apply_slippage_down(100, 20_000) == 0


def test_zero_slippage_is_exact():
    assert apply_slippage_up(1_000_000, 0) == 1_000_000


# -- instruction encoding --------------------------------------------------


@pytest.fixture
def accounts() -> TradeAccounts:
    return TradeAccounts.build(user=USER, mint=MINT, creator=USER, fee_recipient=USER)


def test_buy_instruction_encodes_amount_and_bound(accounts):
    ix = buy_instruction(accounts, 5_000_000, 1_100_000)
    assert ix.data[:8] == BUY_DISCRIMINATOR
    assert struct.unpack("<QQ", ix.data[8:]) == (5_000_000, 1_100_000)
    assert len(ix.accounts) == len(BUY_ACCOUNTS)


def test_sell_instruction_encodes_amount_and_minimum(accounts):
    ix = sell_instruction(accounts, 5_000_000, 900_000)
    assert ix.data[:8] == SELL_DISCRIMINATOR
    assert struct.unpack("<QQ", ix.data[8:]) == (5_000_000, 900_000)


def test_buy_refuses_an_unbounded_spend(accounts):
    """max_sol_cost is the only thing bounding the spend, so it cannot be
    zero or negative."""
    with pytest.raises(ValueError, match="slippage bound"):
        buy_instruction(accounts, 1_000, 0)


def test_both_instructions_reject_a_zero_amount(accounts):
    with pytest.raises(ValueError, match="positive"):
        buy_instruction(accounts, 0, 1_000)
    with pytest.raises(ValueError, match="positive"):
        sell_instruction(accounts, 0, 0)


def test_sell_allows_a_zero_floor(accounts):
    """An exit that will not fill is how a stop-loss becomes a total loss."""
    assert sell_instruction(accounts, 1_000, 0) is not None


def test_only_the_user_signs(accounts):
    for ix in (buy_instruction(accounts, 1, 1), sell_instruction(accounts, 1, 0)):
        signers = [m.pubkey for m in ix.accounts if m.is_signer]
        assert signers == [USER]


def test_buy_and_sell_order_creator_vault_differently(accounts):
    """The one place the two account lists differ. Asserted so a careless
    edit that unifies them fails here rather than on-chain."""
    buy_names = [name for name, _ in BUY_ACCOUNTS]
    sell_names = [name for name, _ in SELL_ACCOUNTS]
    assert buy_names.index("creator_vault") > buy_names.index("token_program")
    assert sell_names.index("creator_vault") < sell_names.index("token_program")
    assert sorted(buy_names) == sorted(sell_names)


def test_writable_flags_match_the_idl(accounts):
    ix = buy_instruction(accounts, 1, 1)
    flags = {str(m.pubkey): m.is_writable for m in ix.accounts}
    assert flags[str(accounts.bonding_curve)]
    assert flags[str(accounts.associated_user)]
    assert not flags[str(MINT)]


def test_ata_creation_is_idempotent_variant():
    ix = create_ata_idempotent_instruction(USER, USER, MINT)
    assert ix.data == bytes([1])
    assert ix.accounts[1].pubkey == associated_token_address(USER, MINT)


# -- jito ------------------------------------------------------------------


def test_tip_account_choice_is_deterministic():
    """A retry must rebuild identical bytes, or it becomes a second
    transaction that could also land."""
    assert tip_account(7) == tip_account(7)
    assert tip_account(1) != tip_account(2)


def test_tip_accounts_are_valid_pubkeys():
    for address in TIP_ACCOUNTS:
        assert Pubkey.from_string(address)
