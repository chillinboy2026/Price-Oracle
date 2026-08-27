# Price Oracle

A fair-market price oracle for real world assets (RWAs) and pre-IPO markets,
designed to be deployable on any EVM chain and verifiable entirely on-chain.

The core idea: an independent network of off-chain reporter nodes computes a
fair price by blending a live reference market (during trading hours) with a
bounded synthetic model driven by real on-chain trading pressure (off hours,
or for assets with no public market at all, like pre-IPO). A threshold of
those reporters signs the agreed price as an EIP-712 attestation, and a
minimal, chain-agnostic smart contract verifies the signatures and enforces
hard on-chain guardrails before ever updating the price. A market-maker
vault sits on top, funding liquidity and taking the other side of leveraged
trades, earning fees while an inventory-skew mechanism keeps it from being
one-sided prey for manipulation and permissionless keepers liquidate
positions that fall below maintenance margin.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

## Repo layout

```
contracts/   Solidity: PriceOracle, MarketMakerVault (leverage + liquidation),
             AnchorRegistry (pre-IPO valuation anchors)
offchain/    TypeScript: fair-price engine, multi-exchange live feed,
             cap-table/waterfall math, anchor book, comparables basket +
             beta estimation, EIP-712 signers, reporter-node simulation,
             on-chain publisher
pumpfun/     Python: a separate, self-contained project -- an agent-scored
             pump.fun trading pipeline (see pumpfun/README.md). Unrelated to
             the oracle above; it shares the repo, not the codebase.
docs/        Architecture write-up
```

## Getting started

```bash
pnpm install

# Contracts: compile + run the Hardhat/chai test suite
pnpm contracts:test

# Off-chain engine: run the vitest suite
pnpm offchain:test

# End-to-end demo of the live-feed pipeline against local venues speaking
# each exchange's real response shape. Needs no network and no API keys --
# shows normal aggregation, an outlier venue being discarded, and the feed
# losing quorum and degrading to the off-hours model.
pnpm --filter ./offchain demo

# Walk the pre-IPO anchor lifecycle: headline valuation -> cap-table
# waterfall -> common price -> anchor + band -> order flow inside the band
# -> band widening with age -> a new anchor resetting it.
pnpm --filter ./offchain demo:preipo

# Comparables tracking: estimate beta to a public SaaS basket, then run an
# 18-month Series-D-to-IPO simulation comparing a static anchor against a
# comps-tracked one.
pnpm --filter ./offchain demo:comps

# How market sentiment and comparables share control: the conviction
# threshold, diminishing returns on conviction, the cap that keeps evidence
# in the majority, and how a stale anchor cedes ground to the market.
pnpm --filter ./offchain demo:hype

# What it costs to hold the mark displaced: required position size, daily
# carry, who receives it, and how quickly funding overtakes the entry fee.
pnpm --filter ./offchain demo:funding

# Run the off-chain orchestrator locally against real crypto exchanges
# (dry-run: logs what it would publish on-chain; set RPC_URL /
# ORACLE_ADDRESS / PUBLISHER_PRIVATE_KEY to actually publish)
cd offchain && pnpm dev
```

### Live feed configuration

`pnpm dev` polls real public exchange endpoints by default — no API keys and
no data licence required.

| Env var | Default | Meaning |
|---|---|---|
| `FEED_MODE` | `crypto` | `crypto` polls real exchanges; `mock` runs the simulated equity-hours walk |
| `FEED_SYMBOL` | `BTC-USD` | Canonical symbol (`BTC-USD`, `ETH-USD`, `SOL-USD`) |
| `FEED_MIN_SOURCES` | `3` | Venues that must agree before any price is published |
| `FEED_POLL_INTERVAL_MS` | `5000` | Exchange poll cadence (governs rate limiting) |
| `TICK_INTERVAL_MS` | `10000` | How often the oracle publishes, independent of polling |
| `VERBOSE_FEED` | unset | Set to `1` to log every successful aggregation |

If fewer than `FEED_MIN_SOURCES` venues respond, the feed reports no quote
rather than a weakly-sourced one, and the system degrades to the same
bounded off-hours model a closed equity market would use.

Note on sandboxed environments: if outbound HTTPS to exchange hosts is
blocked by an egress policy, `pnpm dev` will report every venue failing and
fall back to the off-hours model — that is the designed outage behavior, not
a bug. Use `pnpm --filter ./offchain demo` to exercise the full live path
without network access.

Note on compiling contracts in this environment: `contracts/scripts/compile.cjs`
compiles with the `solc` npm package (pinned in `contracts/package.json`)
instead of Hardhat's built-in downloader, because Hardhat fetches the
compiler binary from `binaries.soliditylang.org`, which is blocked by this
sandbox's network policy. `pnpm contracts:test` / `pnpm contracts:build`
already run this automatically. In an environment with normal network
access, `npx hardhat compile` inside `contracts/` works too, using the same
pinned solc version from `hardhat.config.ts`.

## Status

This is a working skeleton of every core piece (on-chain oracle +
guardrails, leveraged market-maker vault with liquidations, multi-exchange
live feed, pre-IPO anchor registry with cap-table math and comparables
tracking, off-chain engine + reporter network simulation), not a production
system. 211 tests pass across both packages.

See "Known simplifications and next steps" in the architecture doc for
what's deliberately left out -- notably multi-LP share accounting, partial
liquidations, volume-weighted feed aggregation, and a
real option-pricing-model valuation (the cap-table math is a labelled
approximation, not a 409A). The comparables model's beta and basket are
configured inputs, and choosing them well is an empirical problem this repo
does not solve.

None of this has been through a security audit, and the economic parameters
(fee levels, maintenance margin, payout caps, band widths) are illustrative
defaults rather than calibrated values.
