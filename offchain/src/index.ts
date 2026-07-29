import { JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { median } from "./aggregation/median.js";
import { FairPriceEngineConfig } from "./engine/FairPriceEngine.js";
import { MockLiveFeed } from "./feeds/MockLiveFeed.js";
import { ConsolePublisher } from "./publisher/ConsolePublisher.js";
import { OnChainPublisher } from "./publisher/OnChainPublisher.js";
import { Publisher } from "./publisher/types.js";
import { ReporterNode } from "./reporter/ReporterNode.js";
import { oracleDomain, signAttestation, toSolidityAttestation } from "./signer/attestation.js";
import { MarketSession } from "./types.js";
import { mulberry32 } from "./util/rng.js";

const ASSET_SYMBOL = process.env.ASSET_SYMBOL ?? "AAPL";
const ASSET_ID = keccak256(toUtf8Bytes(ASSET_SYMBOL));
const REPORTER_COUNT = Number(process.env.REPORTER_COUNT ?? 3);
const THRESHOLD = Number(process.env.REPORTER_THRESHOLD ?? 2);
const AGREEMENT_TOLERANCE_BPS = Number(process.env.AGREEMENT_TOLERANCE_BPS ?? 25);
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS ?? 10_000);
const INITIAL_PRICE = Number(process.env.INITIAL_PRICE ?? 190);

const engineConfig: FairPriceEngineConfig = {
  guardrails: { maxDeviationBpsLive: 200, maxDeviationBpsOffHours: 50 },
  liveBlendWeight: 0.5,
  offHoursVolatilityBpsPerTick: 5,
  skewInfluenceBps: 20,
  reconciliationSteps: 5,
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
  const feed = new MockLiveFeed({
    initialPrice: INITIAL_PRICE,
    annualizedVolatility: 0.3,
    sessionStartUtcHour: 13,
    sessionEndUtcHour: 20,
  });

  const reporters = Array.from(
    { length: REPORTER_COUNT },
    (_, i) => new ReporterNode(Wallet.createRandom(), INITIAL_PRICE, { ...engineConfig, random: mulberry32(1000 + i) }, 5)
  );

  const { chainId, verifyingContract } = await resolveDomain();
  const domain = oracleDomain(chainId, verifyingContract);
  const publisher = await resolvePublisher();

  console.log(`Price Oracle off-chain engine started for ${ASSET_SYMBOL} (assetId ${ASSET_ID})`);
  console.log(`Simulating ${REPORTER_COUNT} independent reporter nodes, threshold ${THRESHOLD}:`);
  for (const r of reporters) console.log(`  - ${r.wallet.address}`);

  // In a real deployment this reads MarketMakerVault.getInventorySkewBps()
  // for the asset via an on-chain call each tick; wiring that up is a
  // one-line change once a vault is deployed, everything downstream already
  // consumes it as a plain signed bps number.
  const inventorySkewBps = 0;

  let nonce = 0n;

  setInterval(async () => {
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

    console.log(
      `[tick] session=${MarketSession[session]} price=${canonicalPrice.toFixed(4)} signers=${agreeing.length}/${reporters.length}`
    );
    await publisher.publish(attestation, signatures);

    for (const r of reporters) r.syncTo(canonicalPrice, timestamp, session, nonce);
  }, TICK_INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
