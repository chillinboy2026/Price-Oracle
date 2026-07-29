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
contracts/   Solidity: PriceOracle, MarketMakerVault (leverage + liquidation)
             (Hardhat + solc, TS tests)
offchain/    TypeScript: fair-price engine, mock live feed, EIP-712 signer,
             reporter-node simulation, on-chain publisher
docs/        Architecture write-up
```

## Getting started

```bash
pnpm install

# Contracts: compile + run the Hardhat/chai test suite
pnpm contracts:test

# Off-chain engine: run the vitest suite
pnpm offchain:test

# Run the off-chain orchestrator locally (dry-run: logs what it would
# publish on-chain; set RPC_URL/ORACLE_ADDRESS/PUBLISHER_PRIVATE_KEY to
# actually publish to a deployed PriceOracle)
cd offchain && pnpm dev
```

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
guardrails, leveraged market-maker vault with liquidations, off-chain
engine + reporter network simulation), not a production system. 61 tests
pass across both packages. See "Known simplifications and next steps" in
the architecture doc for what's deliberately left out -- notably funding
rates, multi-LP share accounting, and partial liquidations.

None of this has been through a security audit, and the economic
parameters (fee levels, maintenance margin, payout caps) are illustrative
defaults rather than calibrated values.
