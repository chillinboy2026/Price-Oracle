import { JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { median } from "./aggregation/median.js";
import { FairPriceEngineConfig } from "./engine/FairPriceEngine.js";
import { FeedMode, resolveFeed } from "./feeds/resolveFeed.js";
import { ConsolePublisher } from "./publisher/ConsolePublisher.js";
import { OnChainPublisher } from "./publisher/OnChainPublisher.js";
import { Publisher } from "./publisher/types.js";
import { ReporterNode } from "./reporter/ReporterNode.js";
import { oracleDomain, signAttestation, toSolidityAttestation } from "./signer/attestation.js";
import { MarketSession } from "./types.js";
import { mulberry32 } from "./util/rng.js";

/** "crypto" polls real public exchange endpoints; "mock" runs the simulated
 * equity-hours random walk. Crypto is the default because it needs no API
 * keys and no data licence. */
const FEED_MODE = (process.env.FEED_MODE ?? "crypto") as FeedMode;
/** Canonical symbol for the live feed (BTC-USD, ETH-USD, SOL-USD). */
const FEED_SYMBOL = process.env.FEED_SYMBOL ?? "BTC-USD";
/** On-chain asset identifier. Defaults to the feed symbol so the published
 * price and the thing it prices cannot silently diverge. */
const ASSET_SYMBOL = process.env.ASSET_SYMBOL ?? FEED_SYMBOL;
const ASSET_ID = keccak256(toUtf8Bytes(ASSET_SYMBOL));
const REPORTER_COUNT = Number(process.env.REPORTER_COUNT ?? 3);
const THRESHOLD = Number(process.env.REPORTER_THRESHOLD ?? 2);
const AGREEMENT_TOLERANCE_BPS = Number(process.env.AGREEMENT_TOLERANCE_BPS ?? 25);
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS ?? 10_000);
/** Exchange poll cadence, kept independent of the engine tick so rate limits
 * are governed by this alone. */
const FEED_POLL_INTERVAL_MS = Number(process.env.FEED_POLL_INTERVAL_MS ?? 5_000);
const FEED_MIN_SOURCES = Number(process.env.FEED_MIN_SOURCES ?? 3);
const INITIAL_PRICE = Number(process.env.INITIAL_PRICE ?? 190);
const VERBOSE_FEED = process.env.VERBOSE_FEED === "1";

const engineConfig: FairPriceEngineConfig = {
  guardrails: { maxDeviationBpsLive: 200, maxDeviationBpsOffHours: 50 },
  liveBlendWeight: 0.5,
  offHoursVolatilityBpsPerTick: 5,
  reconciliationSteps: 5,
  // A liquid public-market asset has a live feed to price off, so order flow
  // against the vault should only ever nudge the mark. The conviction
  // threshold still applies: transient imbalance moves nothing.
  marketPressure: {
    thresholdBps: 1_500,
    saturationBps: 3_000,
    marketShareOfBandBps: 6_000,
    maxDisplacementBpsNoAnchor: 50,
  },
};

async function resolvePublisher(): Promise<Publisher> {
  const rpcUrl = process.env.RPC_URL;
  const oracleAddress = process.env.ORACLE_ADDRESS;
  const publisherKey = process.env.PUBLISHER_PRIVATE_KEY;
  if (!rpcUrl || !oracleAddress || !publisherKey) {
    console.log(
      "RPC_URL / ORACLE_ADDRESS / PUBLISHER_PRIVATE_KEY not fully set -- running in dry-run mode, no on-chain calls will be made."
    );
    return new ConsolePublisher();
  }
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(publisherKey, provider);
  return new OnChainPublisher(oracleAddress, signer);
}

async function resolveDomain(): Promise<{ chainId: bigint; verifyingContract: string }> {
  const rpcUrl = process.env.RPC_URL;
  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (!rpcUrl || !oracleAddress) {
    // Dry-run: nothing on-chain verifies these signatures, so any stable
    // values keep signing deterministic across runs.
    return { chainId: 31337n, verifyingContract: "0x0000000000000000000000000000000000000000" };
  }
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  return { chainId: network.chainId, verifyingContract: oracleAddress };
}

async function main() {
  const resolved = await resolveFeed({
    mode: FEED_MODE,
    symbol: FEED_SYMBOL,
    initialPrice: INITIAL_PRICE,
    minSources: FEED_MIN_SOURCES,
    pollIntervalMs: FEED_POLL_INTERVAL_MS,
    verbose: VERBOSE_FEED,
  });
  const { feed, initialPrice } = resolved;

  const reporters = Array.from(
    { length: REPORTER_COUNT },
    (_, i) => new ReporterNode(Wallet.createRandom(), initialPrice, { ...engineConfig, random: mulberry32(1000 + i) }, 5)
  );

  const { chainId, verifyingContract } = await resolveDomain();
  const domain = oracleDomain(chainId, verifyingContract);
  const publisher = await resolvePublisher();

  console.log(`Price Oracle off-chain engine started for ${ASSET_SYMBOL} (assetId ${ASSET_ID})`);
  console.log(`Feed: ${resolved.describe}`);
  console.log(`Seed price: ${initialPrice.toFixed(4)}`);
  console.log(`Simulating ${REPORTER_COUNT} independent reporter nodes, threshold ${THRESHOLD}:`);
  for (const r of reporters) console.log(`  - ${r.wallet.address}`);

  const shutdown = () => {
    resolved.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // In a real deployment this reads MarketMakerVault.getInventorySkewBps()
  // for the asset via an on-chain call each tick; wiring that up is a
  // one-line change once a vault is deployed, everything downstream already
  // consumes it as a plain signed bps number.
  const inventorySkewBps = 0;

  let nonce = 0n;

  const tick = async () => {
    const now = new Date();
    const liveQuote = feed.quote(now);
    const timestamp = Math.floor(now.getTime() / 1000);

    const candidates = reporters.map((r) => r.observe({ liveQuote, inventorySkewBps, now: timestamp }));
    const canonicalPrice = median(candidates);
    const session = liveQuote ? MarketSession.LIVE : MarketSession.OFF_HOURS;
    nonce += 1n;

    const canonicalResult = {
      price: canonicalPrice,
      timestamp,
      session,
      nonce,
      confidenceBps: session === MarketSession.LIVE ? 10 : 50,
    };

    const agreeing = reporters.filter((r) => r.agreesToSign(canonicalPrice, AGREEMENT_TOLERANCE_BPS));
    if (agreeing.length < THRESHOLD) {
      console.warn(
        `[tick] only ${agreeing.length}/${THRESHOLD} reporters agree with the canonical price (${canonicalPrice.toFixed(
          4
        )}); skipping this round.`
      );
      return;
    }

    const attestation = toSolidityAttestation(ASSET_ID, canonicalResult);
    const signatures = await Promise.all(agreeing.map((r) => signAttestation(r.wallet, domain, attestation)));

    const reference = liveQuote ? ` ref=${liveQuote.price.toFixed(4)}` : "";
    console.log(
      `[tick] session=${MarketSession[session]} price=${canonicalPrice.toFixed(4)}${reference} ` +
        `signers=${agreeing.length}/${reporters.length}`
    );
    await publisher.publish(attestation, signatures);

    for (const r of reporters) r.syncTo(canonicalPrice, timestamp, session, nonce);
  };

  // A publish can fail for entirely routine reasons -- a flaky RPC, or the
  // oracle's own deviation guardrail rejecting the update -- and none of them
  // should take the process down. Log and wait for the next tick.
  setInterval(() => {
    void tick().catch((err) => {
      console.error(`[tick] failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, TICK_INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
