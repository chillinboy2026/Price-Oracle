"""pump.fun program constants, account layouts, and instruction building.

READ THIS BEFORE ENABLING ``mode: live``
========================================

pump.fun is a live program that has changed its account list more than once
(the creator-fee vault was added to both instructions after launch). Any
hardcoded account ordering can therefore go stale, and a stale ordering
produces a transaction the program rejects.

Three things in this codebase contain that risk:

1. **Nothing magic is hardcoded that can be derived.** The instruction
   discriminators are computed with Anchor's own scheme -- the first eight
   bytes of ``sha256("global:<name>")`` -- rather than pasted as integers.
   The ``global`` and ``__event_authority`` addresses are derived as PDAs.
   Deriving them means they are checkable: :func:`self_check` asserts the
   derived values equal the well-known published ones, so a wrong program
   ID fails at import rather than on-chain.

2. **The fee recipient and the creator are read from chain state**, never
   hardcoded. Both have changed per-token or over time.

3. **Simulation runs before every send** (``solana.simulate_before_send``).
   A wrong account list fails in simulation, which costs nothing. This is
   the actual safety net, and it is why turning it off earns a startup
   warning.

If simulation starts failing after a program upgrade, either update
:data:`BUY_ACCOUNTS`/:data:`SELL_ACCOUNTS` against the current IDL or
switch ``solana.builder`` to ``remote``, which asks an external service to
build the transaction and signs it locally -- your key still never leaves
this process.
"""

from __future__ import annotations

import hashlib
import struct
from collections.abc import Sequence
from dataclasses import dataclass

from solders.instruction import AccountMeta, Instruction
from solders.pubkey import Pubkey

# -- program addresses -----------------------------------------------------

PUMP_PROGRAM = Pubkey.from_string("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
SYSTEM_PROGRAM = Pubkey.from_string("11111111111111111111111111111111")
TOKEN_PROGRAM = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
ASSOCIATED_TOKEN_PROGRAM = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")

# Published, well-known values. Used only to check the derivations below.
KNOWN_GLOBAL = "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"
KNOWN_EVENT_AUTHORITY = "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"

LAMPORTS_PER_SOL = 1_000_000_000
TOKEN_DECIMALS = 6
TOKEN_UNITS = 10**TOKEN_DECIMALS
TOTAL_SUPPLY = 1_000_000_000.0


def discriminator(name: str) -> bytes:
    """Anchor's instruction discriminator: sha256("global:<name>")[:8]."""
    return hashlib.sha256(f"global:{name}".encode()).digest()[:8]


BUY_DISCRIMINATOR = discriminator("buy")
SELL_DISCRIMINATOR = discriminator("sell")


# -- program-derived addresses ---------------------------------------------


def global_pda() -> Pubkey:
    return Pubkey.find_program_address([b"global"], PUMP_PROGRAM)[0]


def event_authority_pda() -> Pubkey:
    return Pubkey.find_program_address([b"__event_authority"], PUMP_PROGRAM)[0]


def bonding_curve_pda(mint: Pubkey) -> Pubkey:
    return Pubkey.find_program_address([b"bonding-curve", bytes(mint)], PUMP_PROGRAM)[0]


def creator_vault_pda(creator: Pubkey) -> Pubkey:
    return Pubkey.find_program_address([b"creator-vault", bytes(creator)], PUMP_PROGRAM)[0]


def associated_token_address(owner: Pubkey, mint: Pubkey) -> Pubkey:
    return Pubkey.find_program_address(
        [bytes(owner), bytes(TOKEN_PROGRAM), bytes(mint)],
        ASSOCIATED_TOKEN_PROGRAM,
    )[0]


def self_check() -> None:
    """Fail loudly if a derivation stops matching its published value.

    Cheap insurance against a mistyped program ID: every PDA below depends
    on it, so one wrong character would otherwise produce plausible-looking
    addresses that no program owns.
    """
    if str(global_pda()) != KNOWN_GLOBAL:
        raise RuntimeError(
            f"derived global PDA {global_pda()} != published {KNOWN_GLOBAL}; "
            "PUMP_PROGRAM is wrong"
        )
    if str(event_authority_pda()) != KNOWN_EVENT_AUTHORITY:
        raise RuntimeError(
            f"derived event authority {event_authority_pda()} != "
            f"published {KNOWN_EVENT_AUTHORITY}; PUMP_PROGRAM is wrong"
        )


self_check()


# -- account state ---------------------------------------------------------


@dataclass(frozen=True)
class BondingCurve:
    """Decoded ``bonding_curve`` account.

    Layout after the 8-byte discriminator: five ``u64`` reserves, a
    ``bool``, and -- on accounts created since the creator-fee change -- a
    32-byte creator pubkey. Older accounts stop after the bool, so the
    creator is optional rather than assumed.
    """

    virtual_token_reserves: int
    virtual_sol_reserves: int
    real_token_reserves: int
    real_sol_reserves: int
    token_total_supply: int
    complete: bool
    creator: Pubkey | None = None

    SIZE_WITHOUT_CREATOR = 8 + 8 * 5 + 1

    @classmethod
    def parse(cls, data: bytes) -> BondingCurve:
        if len(data) < cls.SIZE_WITHOUT_CREATOR:
            raise ValueError(
                f"bonding curve account too short: {len(data)} bytes, "
                f"expected at least {cls.SIZE_WITHOUT_CREATOR}"
            )
        fields = struct.unpack_from("<QQQQQ?", data, 8)
        creator: Pubkey | None = None
        offset = cls.SIZE_WITHOUT_CREATOR
        if len(data) >= offset + 32:
            candidate = Pubkey(data[offset : offset + 32])
            # An all-zero pubkey means the field exists but is unset.
            if bytes(candidate) != bytes(32):
                creator = candidate
        return cls(
            virtual_token_reserves=fields[0],
            virtual_sol_reserves=fields[1],
            real_token_reserves=fields[2],
            real_sol_reserves=fields[3],
            token_total_supply=fields[4],
            complete=fields[5],
            creator=creator,
        )

    # -- pricing -----------------------------------------------------------

    @property
    def price_sol_per_token(self) -> float:
        """Spot price implied by the virtual reserves."""
        if self.virtual_token_reserves <= 0:
            return 0.0
        return (self.virtual_sol_reserves / LAMPORTS_PER_SOL) / (
            self.virtual_token_reserves / TOKEN_UNITS
        )

    def tokens_out(self, sol_in_lamports: int) -> int:
        """Constant-product quote for a buy, in base token units.

        The curve holds ``virtual_sol * virtual_token`` constant, so
        spending ``x`` lamports yields
        ``virtual_token - (k / (virtual_sol + x))``. Capped at the real
        token reserves, which is what the program will actually release.
        """
        if sol_in_lamports <= 0 or self.virtual_sol_reserves <= 0:
            return 0
        k = self.virtual_sol_reserves * self.virtual_token_reserves
        new_virtual_token = k // (self.virtual_sol_reserves + sol_in_lamports)
        out = self.virtual_token_reserves - new_virtual_token
        return max(0, min(out, self.real_token_reserves))

    def sol_out(self, tokens_in: int) -> int:
        """Constant-product quote for a sell, in lamports."""
        if tokens_in <= 0 or self.virtual_token_reserves <= 0:
            return 0
        k = self.virtual_sol_reserves * self.virtual_token_reserves
        new_virtual_sol = k // (self.virtual_token_reserves + tokens_in)
        return max(0, self.virtual_sol_reserves - new_virtual_sol)


def parse_fee_recipient(global_account: bytes) -> Pubkey:
    """Read ``fee_recipient`` out of the program's global account.

    Layout: 8 discriminator, 1 initialized bool, 32 authority, then the
    fee recipient. Read rather than hardcoded because it has been rotated.
    """
    offset = 8 + 1 + 32
    if len(global_account) < offset + 32:
        raise ValueError("global account too short to contain fee_recipient")
    return Pubkey(global_account[offset : offset + 32])


# -- instruction building --------------------------------------------------

# Account order, as a named table rather than inline literals so that a
# program upgrade is a one-line edit against the IDL.
#
# Flags: "w" writable, "s" signer, "" read-only.
BUY_ACCOUNTS: tuple[tuple[str, str], ...] = (
    ("global", ""),
    ("fee_recipient", "w"),
    ("mint", ""),
    ("bonding_curve", "w"),
    ("associated_bonding_curve", "w"),
    ("associated_user", "w"),
    ("user", "ws"),
    ("system_program", ""),
    ("token_program", ""),
    ("creator_vault", "w"),
    ("event_authority", ""),
    ("program", ""),
)

# Sell differs from buy in one place -- creator_vault sits before
# token_program rather than after it. Writing both tables out in full,
# rather than deriving one from the other, keeps that difference visible.
SELL_ACCOUNTS: tuple[tuple[str, str], ...] = (
    ("global", ""),
    ("fee_recipient", "w"),
    ("mint", ""),
    ("bonding_curve", "w"),
    ("associated_bonding_curve", "w"),
    ("associated_user", "w"),
    ("user", "ws"),
    ("system_program", ""),
    ("creator_vault", "w"),
    ("token_program", ""),
    ("event_authority", ""),
    ("program", ""),
)


def _metas(order: Sequence[tuple[str, str]], accounts: dict[str, Pubkey]) -> list[AccountMeta]:
    metas = []
    for name, flags in order:
        try:
            pubkey = accounts[name]
        except KeyError as exc:  # pragma: no cover - programming error
            raise KeyError(f"missing account {name!r} for instruction") from exc
        metas.append(
            AccountMeta(pubkey=pubkey, is_signer="s" in flags, is_writable="w" in flags)
        )
    return metas


@dataclass(frozen=True)
class TradeAccounts:
    """Every address one buy or sell needs."""

    user: Pubkey
    mint: Pubkey
    bonding_curve: Pubkey
    associated_bonding_curve: Pubkey
    associated_user: Pubkey
    creator_vault: Pubkey
    fee_recipient: Pubkey

    @classmethod
    def build(cls, user: Pubkey, mint: Pubkey, creator: Pubkey,
              fee_recipient: Pubkey) -> TradeAccounts:
        curve = bonding_curve_pda(mint)
        return cls(
            user=user,
            mint=mint,
            bonding_curve=curve,
            associated_bonding_curve=associated_token_address(curve, mint),
            associated_user=associated_token_address(user, mint),
            creator_vault=creator_vault_pda(creator),
            fee_recipient=fee_recipient,
        )

    def as_map(self) -> dict[str, Pubkey]:
        return {
            "global": global_pda(),
            "fee_recipient": self.fee_recipient,
            "mint": self.mint,
            "bonding_curve": self.bonding_curve,
            "associated_bonding_curve": self.associated_bonding_curve,
            "associated_user": self.associated_user,
            "user": self.user,
            "system_program": SYSTEM_PROGRAM,
            "token_program": TOKEN_PROGRAM,
            "creator_vault": self.creator_vault,
            "event_authority": event_authority_pda(),
            "program": PUMP_PROGRAM,
        }


def buy_instruction(accounts: TradeAccounts, token_amount: int,
                    max_sol_cost: int) -> Instruction:
    """``buy``: take at most ``max_sol_cost`` lamports for ``token_amount``.

    ``max_sol_cost`` is the slippage bound and the only thing standing
    between a quote and an unbounded spend, so it is a required argument
    rather than an option with a default.
    """
    if token_amount <= 0:
        raise ValueError("token_amount must be positive")
    if max_sol_cost <= 0:
        raise ValueError("max_sol_cost must be positive: it is the slippage bound")
    data = BUY_DISCRIMINATOR + struct.pack("<QQ", token_amount, max_sol_cost)
    return Instruction(PUMP_PROGRAM, data, _metas(BUY_ACCOUNTS, accounts.as_map()))


def sell_instruction(accounts: TradeAccounts, token_amount: int,
                     min_sol_output: int) -> Instruction:
    """``sell``: give up ``token_amount``, requiring at least the minimum out.

    ``min_sol_output`` may be zero. Selling is an exit, and an exit that
    refuses to fill because the price moved against it is how a stop-loss
    turns into a total loss.
    """
    if token_amount <= 0:
        raise ValueError("token_amount must be positive")
    if min_sol_output < 0:
        raise ValueError("min_sol_output cannot be negative")
    data = SELL_DISCRIMINATOR + struct.pack("<QQ", token_amount, min_sol_output)
    return Instruction(PUMP_PROGRAM, data, _metas(SELL_ACCOUNTS, accounts.as_map()))


def create_ata_idempotent_instruction(payer: Pubkey, owner: Pubkey,
                                      mint: Pubkey) -> Instruction:
    """Create the buyer's token account if it does not exist.

    The idempotent variant (discriminant ``1``) succeeds when the account
    is already there, so the buy path needs no extra RPC round trip to
    find out -- and no race between checking and creating.
    """
    return Instruction(
        ASSOCIATED_TOKEN_PROGRAM,
        bytes([1]),
        [
            AccountMeta(pubkey=payer, is_signer=True, is_writable=True),
            AccountMeta(pubkey=associated_token_address(owner, mint),
                        is_signer=False, is_writable=True),
            AccountMeta(pubkey=owner, is_signer=False, is_writable=False),
            AccountMeta(pubkey=mint, is_signer=False, is_writable=False),
            AccountMeta(pubkey=SYSTEM_PROGRAM, is_signer=False, is_writable=False),
            AccountMeta(pubkey=TOKEN_PROGRAM, is_signer=False, is_writable=False),
        ],
    )


def apply_slippage_up(lamports: int, slippage_bps: int) -> int:
    """Buy bound: what you will pay at worst."""
    return lamports + (lamports * slippage_bps) // 10_000


def apply_slippage_down(lamports: int, slippage_bps: int) -> int:
    """Sell bound: what you will accept at least."""
    return max(0, lamports - (lamports * slippage_bps) // 10_000)
