# Architecture

## Goal

Produce a fair market price for a real world asset (a public equity, a
pre-IPO company, a bond, etc.) that:

1. Tracks the real market closely while it's trading.
2. Stays "live" -- responsive to real trading activity -- while the real
   market is closed, instead of freezing or being purely synthetic.
3. Cannot be moved by a single party: not a single reporter, not a single
   large trade against the market maker, not a single stale/faulty feed.
4. Is verifiable entirely on-chain, on any EVM chain, without trusting a
   specific off-chain operator.
5. Works for assets that have no continuous public market at all (pre-IPO),
   where "off-hours" is closer to "always."

## Components

```
┌─────────────────────────────┐        ┌───────────────────────────────┐
│        Off-chain            │        │            On-chain            │
│                              │        │                                 │
│  Live market feed            │        │                                 │
│        │                     │        │                                 │
│        ▼                     │        │                                 │
│  ┌───────────────┐  x N      │        │                                 │
│  │ Reporter node  │  reporters│        │                                 │
│  │ FairPriceEngine│──┐        │        │                                 │
│  └───────────────┘  │        │        │                                 │
│                      ▼        │        │                                 │
│              median() ─────► canonical │  updatePrice(attestation, sigs) │
│              aggregation      attestation ───────►  PriceOracle.sol      │
│                      │        │        │   - verify EIP-712 sigs         │
│           each reporter checks│        │   - threshold check             │
│           agreement, signs if │        │   - staleness / nonce checks    │
│           within tolerance    │        │   - deviation guardrail         │
│                      │        │        │            │                    │
│                      ▼        │        │            ▼                    │
│               publish() ──────┼───────►│      AssetState.price           │
└──────────────────────────────┘        │            │                    │
                                          │            ▼                    │
                                          │     MarketMakerVault.sol        │
                                          │   - MM liquidity + fees         │
                                          │   - trader long/short positions │
                                          │   - inventory skew → taker fee  │
                                          └───────────────────────────────┘
                                                       │
                                          inventorySkewBps (informational,
                                          read back by the off-chain engine)
```

### `contracts/contracts/PriceAttestationLib.sol`

Defines the single data structure that everything else hangs off:

```solidity
struct PriceAttestation {
    bytes32 assetId;
    uint256 price;          // 1e18 fixed point
    uint256 timestamp;      // unix seconds, off-chain computation time
    MarketSession session;  // LIVE or OFF_HOURS
    uint256 confidenceBps;  // reporter's self-reported confidence width
    uint256 nonce;          // strictly increasing per asset
}
```

This struct, its EIP-712 typehash, and its field order are mirrored exactly
in `offchain/src/signer/attestation.ts`. That's the entire contract between
the off-chain and on-chain worlds -- deliberately small, so it's trivial to
re-implement on a different EVM chain (same Solidity, unmodified) or behind
an adapter on a non-EVM chain later without touching the off-chain engine.

### `contracts/contracts/PriceOracle.sol`

Holds price state per `assetId` and accepts updates via
`updatePrice(attestation, signatures[])`. An update is only accepted if:

- **Threshold multi-sig**: at least `threshold` distinct addresses holding
  `REPORTER_ROLE` signed the *exact same* attestation (same EIP-712 digest).
  No single reporter can move the price alone, and duplicate signatures from
  one reporter don't count twice.
- **Freshness**: `attestation.timestamp` isn't stale (`maxStaleness`) or
  implausibly in the future.
- **Monotonic nonce**: strictly increasing per asset, so an old attestation
  can't be replayed out of order even if timestamps happened to collide.
- **Absolute bounds**: optional `minPrice`/`maxPrice` sanity floor/ceiling.
- **Deviation guardrail**: the move from the last accepted price is capped
  at `maxDeviationBpsLive` while `session == LIVE`, or the tighter
  `maxDeviationBpsOffHours` while the reference market is closed (there's no
  independent market to cross-check an off-hours move against, so off-hours
  moves get less benefit of the doubt). **A move that would exceed the
  guardrail simply reverts** -- the price freezes rather than jumping. That
  is the deliberate fail-safe behavior under a manipulation attempt or a
  feed outage: better to serve a slightly stale price than an attacker-fed
  one.

Legitimate large repricings (an overnight earnings gap, a new priced funding
round for a pre-IPO asset) go through `guardianOverridePrice`, which still
requires the full reporter signature threshold but is restricted to
`GUARDIAN_ROLE` and emits a distinct `PriceOverridden` event, so every
override is transparent and attributable rather than silently bypassing the
guardrail through the normal path.

Consumers read `getPrice(assetId)` or `getPriceNoOlderThan(assetId, maxAge)`
via the small `IPriceOracle` interface.

### `contracts/contracts/MarketMakerVault.sol`

The leveraged liquidity/fee layer: a market maker deposits quote-token
capital, traders open leveraged long/short exposure to the oracle price
against that pool, permissionless keepers liquidate positions that fall
below maintenance margin, and the market maker earns fees for taking the
other side. Key properties:

- **The oracle's price is never touched by trading.** Every fill *and every
  liquidation* uses `PriceOracle.getPrice()` directly -- a trader cannot
  move the mid by trading size against the vault, and cannot push anyone
  else into liquidation by trading either.
- **What a trader can influence is the fee.** `quoteFeeBps(isLong)` starts
  at `baseFeeBps` and is skewed by the vault's current inventory
  (`getInventorySkewBps()`): trading in the direction that *worsens* the
  existing imbalance costs progressively more (up to `maxFeeBps`); trading
  in the direction that *reduces* it gets progressively cheaper, floored at
  zero. That's what keeps the vault sustaining both buyers and sellers
  instead of only ever favoring one side, without ever distorting the
  independently-attested mid price.
- **Bounded liability.** Every position reserves
  `margin * (maxPayoutMultipleBps - 1x)` of *MM* capital at open time --
  precisely the worst case the MM can owe beyond the trader's own escrowed
  collateral -- and the open is rejected unless `availableLiquidity()`
  covers it. Payout is capped at `maxPayoutMultipleBps × margin`.

#### Accounting: three separated pools

Leverage makes it unacceptable to conflate trader collateral with
market-maker capital, so the vault keeps three strictly separate ledgers:

| Ledger | Whose money | Moves when |
|---|---|---|
| `totalLiquidity` | MM capital | Trader realizes a loss (grows), trader realizes a profit (shrinks), MM's share of a liquidation penalty (grows) |
| `totalMargin` | Trader collateral in escrow | Position opens (grows) / settles (shrinks) |
| `feesAccrued` | MM fee revenue | Open and close fees; withdrawable without touching capital backing open positions |

The contract's token balance always equals the sum of the three, exposed as
`solvencyInvariantHolds()` and asserted after every operation in the test
suite (including across a mixed open/liquidate/close sequence).

#### Leverage

`openPosition(isLong, margin, leverageBps)` sizes `notional = margin ×
leverage`, capped by `maxLeverageBps`. As on any perp venue the fee is
charged on *notional*, not margin, so leverage scales the cost of the trade
too (10x on a 1% base fee costs 10% of margin round-trip-ish). PnL is
correspondingly amplified: a +10% spot move on 5x returns +50% on margin.

#### Liquidation

A position is liquidatable once its equity (`margin + unrealized pnl`)
falls below `notional × maintenanceMarginBps`. `getLiquidationPrice()`
inverts that condition in closed form:

```
long:   P_liq = entry × (1 + mmBps/BPS − margin/notional)
short:  P_liq = entry × (1 − mmBps/BPS + margin/notional)
```

`liquidate(positionId)` is permissionless. The liquidated position's
residual equity pays a penalty of `liquidationPenaltyBps` of notional,
split between the keeper (`liquidatorShareBps`) and the market maker;
whatever survives the penalty is refunded to the trader. Conservation is
exact: keeper reward + trader refund + MM credit always equals the escrowed
margin.

**Liquidations deliberately still work while the vault is paused.** Pausing
stops *new* risk from being opened, but blocking liquidations would strand
the market maker holding undercollateralized exposure -- precisely the
situation pausing exists to contain.

#### Gap risk, and why the oracle guardrail matters here

If price moves far enough in one step that equity goes negative before a
keeper can act, the trader is refunded nothing, the market maker collects
the full margin, and the MM's *uncollected* winnings beyond that margin are
recorded in `cumulativeShortfall`. Note this is missed profit rather than a
drain on pooled capital -- the pool still nets the whole margin -- but a
rising number means liquidations are firing too late.

This is where the two halves of the system reinforce each other: the
oracle's per-update deviation guardrail bounds how far the mark price can
move in a single update, which structurally gives keepers a window to
liquidate before a position goes bankrupt. An oracle that could jump
arbitrarily far in one update would make bounded-loss leverage impossible
downstream. The shortfall test exercises exactly this by configuring a
deliberately wide guardrail so a 10x position can gap straight past
bankruptcy in one attestation.

`getInventorySkewBps()` is also read by the off-chain engine as one more
input into the next price attestation (see below) -- real trading pressure
against the vault feeds back into the fair-price model, particularly useful
off-hours when there's no live market to react to instead.

### `offchain/src/feeds/` -- the live market feed

`LiveFeed` is a one-method interface (`quote(now)` returns a price or `null`),
with two implementations:

- **`AggregatedLiveFeed`** -- the real one. Polls several public crypto
  exchanges at once (Coinbase, Kraken, Gemini, Bitstamp, Binance) via keyless
  REST endpoints and aggregates them.
- **`MockLiveFeed`** -- the simulated equity-hours random walk, kept for
  offline development and for exercising the closed-market path.

Selected by `FEED_MODE` (`crypto` by default). Crypto is the pragmatic
starting point: no API keys, no data licence, and 24/7 trading. Real-time
*equity* data is the harder problem, and it is a licensing problem more than
a technical one -- most vendors' redistribution terms do not permit
republishing prices on-chain. Adding an equities vendor means writing one
more `ExchangeAdapter`; the rest of the system does not change.

#### Aggregation and manipulation resistance

A single exchange is a single point of manipulation, so the feed never
trusts one. Each poll:

1. Queries every venue in parallel (`Promise.allSettled`, so one hanging
   venue cannot stall the round), with a per-attempt timeout and bounded
   retries. 5xx and 429 are retried; other 4xx are not, since retrying a
   malformed request just burns rate limit.
2. Prices each venue at its **bid/ask midpoint** rather than its last trade.
   A single print can be walked by a small trade; moving the midpoint
   requires standing in the book on both sides.
3. **Drops venues with a blown-out spread** (`maxSpreadBps`) -- a wide book
   signals thin or broken liquidity whose midpoint is cheap to move.
4. **Drops outliers**: take a provisional median, discard venues further
   than `maxDeviationBps` from it, then re-median the survivors.
5. **Requires a quorum** (`minSources`). Below it, the feed publishes
   nothing rather than a weakly-sourced price.

The security property this buys is precise, and worth stating exactly: a
single compromised venue *cannot move the published price meaningfully*, and
critically, **lying harder buys the attacker nothing** -- once a venue is
outside the outlier band its print is discarded outright, so a 50x lie and a
5,000,000x lie have identical (zero) effect. Removing a venue from the set
does shift the median slightly, but that shift is bounded by the dispersion
between *honest* venues, not by the size of the lie. Both properties are
asserted in `test/AggregatedLiveFeed.test.ts`.

#### Degradation is the off-hours path

Polling happens on its own schedule and `quote()` reads a cached snapshot,
which keeps the engine's tick rate decoupled from exchange rate limits and
lets the engine stay a pure synchronous function of its inputs. If the cache
goes older than `maxQuoteAgeMs`, or a poll cannot reach quorum for long
enough, `quote()` returns `null`.

That `null` is the same signal a closed equity market produces. So a crypto
exchange outage degrades along *exactly* the same path as an overnight
equity session: the engine falls back to its bounded synthetic model and the
oracle contract applies its tighter off-hours guardrail, with no
special-casing anywhere. `MarketSession.OFF_HOURS` is really "no trustworthy
live reference right now", and closed markets are just one cause of it.

#### A caveat worth stating: the USDT basis

Binance's deep USD-ish books are quoted in USDT, not USD. That is a
different instrument -- USDT has depegged by tens of bps historically, and
much further under stress -- so this venue is not measuring quite the same
thing as the USD-quoted venues. It is included because its depth makes it
expensive to manipulate. The outlier filter will drop it automatically
during a serious depeg, which handles the tail but *not* the steady-state
basis. A production deployment should either price the USDT/USD leg
explicitly or weight this venue down.

### `offchain/src/engine/FairPriceEngine.ts`

The actual pricing algorithm, run independently by every reporter node.
Each tick:

1. **If the reference market is live** (`MockLiveFeed`, or a real market
   data feed in production, returns a quote): blend the previous fair price
   with the fresh live quote using `liveBlendWeight` (smooths out feed
   noise/micro-spikes rather than tracking every live tick exactly).
2. **If the reference market is closed**: apply a small bounded random step
   (`offHoursVolatilityBpsPerTick`) -- deliberately conservative relative to
   typical intraday live volatility, since there's no independent market to
   check an off-hours move against. This is the "stays live off-hours" half
   of the design: the price keeps moving on its own bounded process instead
   of freezing solid until the market reopens.
3. **In both sessions**, the market maker's inventory skew nudges the price
   a further bounded amount (`skewInfluenceBps`) -- real on-chain trading
   pressure factored directly into the fair price, most valuable exactly
   when there's no live feed to react to it instead.
4. **On reopen** (transition from OFF_HOURS to LIVE), the blend weight is
   ramped up gradually over `reconciliationSteps` ticks rather than jumping
   straight to full weight -- a long off-hours drift can leave the
   synthetic price meaningfully away from the live open, and snapping to it
   in one step would likely itself violate the (tighter, cross-checked)
   LIVE guardrail.
5. **Every result is clamped** with the exact same deviation-guardrail math
   as `PriceOracle._checkDeviation` (`offchain/src/engine/Guardrails.ts`),
   so an attestation built from it is never rejected on-chain purely for
   exceeding the guardrail -- the on-chain check stays authoritative; this
   just avoids wasting a round trip.

### Reporter network / aggregation

`PriceOracle.updatePrice` only accepts signatures over one exact
attestation, so independent reporters have to agree on a single canonical
value before signing -- they can't each just sign their own private
number. The flow (`offchain/src/index.ts`, `ReporterNode.ts`,
`aggregation/median.ts`):

1. Each `ReporterNode` runs its own `FairPriceEngine` against its own
   slightly-noised view of the live feed (simulating independent
   operators/data sources) and produces a candidate price.
2. The network takes the **median** of all candidates as the canonical
   price (resistant to a single outlier/faulty/malicious reporter).
3. Each reporter only signs the canonical attestation if it's within its
   own tolerance of what it independently observed
   (`ReporterNode.agreesToSign`) -- a reporter can't be forced to co-sign a
   price wildly different from its own view.
4. If fewer than `threshold` reporters agree, the round is skipped rather
   than publishing a bad consensus.
5. On a successful publish, every reporter re-anchors its engine to the
   canonical price (`syncTo`) so the next tick blends from ground truth.

This mirrors how real threshold push-oracle networks (e.g. Pyth-style
aggregate-then-sign) work, simulated here as several `ReporterNode`
instances in one process with independent keys and independent randomness
seeds -- swapping this for genuinely separate processes/operators is a
deployment concern, not an architecture change.

### Publishing

`Publisher` is a two-line interface (`offchain/src/publisher/types.ts`):
`ConsolePublisher` logs what would be submitted (the default, so the
orchestrator runs safely with zero chain configuration), and
`OnChainPublisher` calls `PriceOracle.updatePrice` through ethers once
`RPC_URL` / `ORACLE_ADDRESS` / `PUBLISHER_PRIVATE_KEY` are set.

## Chain-agnostic path

`PriceOracle.sol` and `MarketMakerVault.sol` are plain Solidity with no
chain-specific dependencies -- the same bytecode deploys unmodified to any
EVM chain (Ethereum, an L2, an appchain). The attestation format and
signing scheme are simple enough (a struct hash + ECDSA signatures) that a
non-EVM chain can implement a thin native verifier speaking the same
format without changing anything in `offchain/` -- the off-chain network
doesn't know or care which chain it's ultimately publishing to beyond the
`Publisher` implementation it's configured with.

## Pre-IPO markets

A pre-IPO asset has no continuous public market, so it is effectively
*always* in the OFF_HOURS branch of the model: the synthetic drift +
inventory-skew mechanism isn't a fallback, it's the primary pricing engine.
The same `guardianOverridePrice` path used for a public-market earnings gap
doubles as the mechanism for incorporating a discrete real-world repricing
event for a pre-IPO name -- a new priced funding round, a secondary
transaction, a 409A mark -- as an authenticated, threshold-signed,
transparently-logged anchor point, after which the bounded drift model
resumes around the new level.

## Manipulation resistance, summarized

| Vector | Mitigation |
|---|---|
| Single exchange compromised or broken | Cross-venue median with outlier + spread rejection; a more extreme lie buys no extra influence |
| Feeding off a single venue's last trade | Priced off bid/ask midpoint, which requires standing in the book to move |
| All venues unreachable / feed silently dies | Quorum requirement + cache staleness horizon; degrades to the off-hours model, never serves an indefinitely stale price |
| Single reporter goes rogue | Threshold multi-sig; one signer can't move the price |
| Reporter feeds a stale price | On-chain staleness + future-timestamp checks |
| Replay / out-of-order update | Strictly increasing nonce |
| Sudden price jump (attack or bad feed) | On-chain deviation guardrail, tighter off-hours |
| One-sided trading flow against the vault | Inventory-skewed taker fee, oracle mid never touched |
| Vault insolvency from a large position | Per-position MM liability reserved against pool liquidity at open, payout capped |
| Trader spending someone else's collateral | Trader margin escrowed in `totalMargin`, separate from MM capital |
| Leveraged position going bankrupt | Maintenance-margin liquidation by permissionless keepers, paid from the position's own residual equity |
| Price gap outrunning liquidation | Oracle's per-update deviation guardrail bounds single-update moves; residual exposure surfaced as `cumulativeShortfall` |
| Admin pausing to trap the MM in bad positions | `liquidate()` is deliberately callable while paused |
| Legitimate large repricing blocked by guardrail | `GUARDIAN_ROLE`-gated override, fully transparent on-chain |

## Known simplifications and next steps

This is a first working skeleton, not a production system. Explicit,
deliberate simplifications:

- **Reporter network is simulated in one process.** Production needs
  genuinely independent operators, keys held separately, and a real gossip/
  aggregation transport between them instead of in-process objects.
- **No funding rate.** Perp venues charge a periodic funding payment
  between longs and shorts to keep the contract tethered to spot and to
  compensate whoever carries the imbalance. Here the inventory-skewed
  *taker* fee does the balancing work at trade time only -- a trader who
  opens into an imbalance and holds pays nothing extra for the carry. A
  continuous funding accrual on open positions is the natural next
  addition, and it slots in as a per-position accrual against
  `netNotional` without disturbing the settlement math.
- **Single market maker, no LP share accounting.** `MARKET_MAKER_ROLE` is
  one counterparty with an undivided claim on `totalLiquidity`; a real
  venue would tokenize pool ownership so multiple LPs could share fees and
  pnl pro rata.
- **Liquidation is all-or-nothing.** Production venues partially liquidate
  to bring a position back above maintenance margin rather than closing it
  outright, which is gentler on traders and on inventory skew.
- **No keeper incentive floor.** `liquidatorShareBps` of the penalty can
  round to near-zero on a position whose equity is nearly exhausted,
  leaving no economic reason to call `liquidate()` on exactly the positions
  that most need it. A minimum reward funded from the MM's side would fix
  this.
- **Crypto venues only, so far.** The live feed covers public crypto spot
  markets. Equities/RWAs need a licensed vendor (see the feeds section
  above); pre-IPO has no feed to integrate at all and runs on the
  guardian-anchored path described below.
- **No volume weighting.** Aggregation treats a venue with $1bn of depth and
  one with $1m identically. Volume- or depth-weighting the median would make
  it meaningfully harder to influence, at the cost of trusting each venue's
  self-reported volume.
- **Feed adapters are polled over REST, not streamed.** Websocket feeds
  would cut latency substantially; REST polling was chosen for simplicity
  and because the oracle publishes on a slower cadence than it polls anyway.
- **No non-EVM adapter yet** -- the design leaves room for one (see above)
  but none is implemented here.
- **Off-chain -> on-chain wiring for `getInventorySkewBps()`** is stubbed
  at `0` in `index.ts`; wiring it to a live `MarketMakerVault` is a small,
  explicitly-called-out change once a vault is actually deployed alongside
  an oracle for the same asset.
