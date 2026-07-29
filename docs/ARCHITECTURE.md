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

The liquidity/fee layer: a market maker deposits quote-token liquidity,
traders open and close notional long/short exposure to the oracle price
against that pool, and the market maker earns fees for taking the other
side. Key properties:

- **The oracle's price is never touched by trading.** Every fill uses
  `PriceOracle.getPrice()` directly -- a trader cannot move the mid by
  trading size against the vault.
- **What a trader can influence is the fee.** `quoteFeeBps(isLong)` starts
  at `baseFeeBps` and is skewed by the vault's current inventory
  (`getInventorySkewBps()`): trading in the direction that *worsens* the
  existing imbalance costs progressively more (up to `maxFeeBps`); trading
  in the direction that *reduces* it gets progressively cheaper, floored at
  zero. That's what keeps the vault sustaining both buyers and sellers
  instead of only ever favoring one side, without ever distorting the
  independently-attested mid price.
- **Bounded liability.** Every position reserves
  `notional * maxPayoutMultipleBps` against pool liquidity at open time, so
  the market maker's worst-case exposure per position is always provably
  solvent against `availableLiquidity()` before the trade is accepted.
- **Fees are segregated from principal** (`feesAccrued` vs `totalLiquidity`)
  so the market maker can withdraw earned fees without touching the capital
  backing open positions.

`getInventorySkewBps()` is also read by the off-chain engine as one more
input into the next price attestation (see below) -- real trading pressure
against the vault feeds back into the fair-price model, particularly useful
off-hours when there's no live market to react to instead.

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
| Single reporter goes rogue | Threshold multi-sig; one signer can't move the price |
| Reporter feeds a stale price | On-chain staleness + future-timestamp checks |
| Replay / out-of-order update | Strictly increasing nonce |
| Sudden price jump (attack or bad feed) | On-chain deviation guardrail, tighter off-hours |
| One-sided trading flow against the vault | Inventory-skewed taker fee, oracle mid never touched |
| Vault insolvency from a large position | Per-position liability reserved against pool liquidity at open |
| Legitimate large repricing blocked by guardrail | `GUARDIAN_ROLE`-gated override, fully transparent on-chain |

## Known simplifications and next steps

This is a first working skeleton, not a production system. Explicit,
deliberate simplifications:

- **Reporter network is simulated in one process.** Production needs
  genuinely independent operators, keys held separately, and a real gossip/
  aggregation transport between them instead of in-process objects.
- **`MarketMakerVault` positions are 1x, single-MM.** No leverage, no
  multi-LP share accounting, no liquidations -- deliberately out of scope
  since the ask was the pricing model first, a full margin/DEX engine
  second.
- **`MockLiveFeed` is a random walk, not a real data source.** Swapping in
  a real feed only means implementing the two-method `LiveFeed` interface.
- **No non-EVM adapter yet** -- the design leaves room for one (see above)
  but none is implemented here.
- **Off-chain -> on-chain wiring for `getInventorySkewBps()`** is stubbed
  at `0` in `index.ts`; wiring it to a live `MarketMakerVault` is a small,
  explicitly-called-out change once a vault is actually deployed alongside
  an oracle for the same asset.
