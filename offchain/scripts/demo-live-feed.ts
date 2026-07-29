/**
 * End-to-end demonstration of the live-feed pipeline, runnable with no network
 * access and no API keys:
 *
 *   AggregatedLiveFeed (real adapters) -> ReporterNode engines -> median
 *   consensus -> EIP-712 attestation -> signature verification
 *
 * The exchange adapters, aggregation, filtering and signing are all the real
 * production code paths; only the venues themselves are replaced by a local
 * server speaking each exchange's genuine response shape. Run with:
 *
 *   pnpm --filter ./offchain demo
 *
 * The last phase deliberately knocks venues offline to show the feed losing
 * quorum and the pipeline degrading to the bounded off-hours model rather than
 * publishing a weakly-sourced price.
 */
import { Wallet, keccak256, toUtf8Bytes, verifyTypedData } from "ethers";
import { median } from "../src/aggregation/median.js";
import { AggregatedLiveFeed } from "../src/feeds/AggregatedLiveFeed.js";
import {
  BinanceAdapter,
  BitstampAdapter,
  CoinbaseAdapter,
  GeminiAdapter,
  KrakenAdapter,
} from "../src/feeds/exchanges/adapters.js";
import { ReporterNode } from "../src/reporter/ReporterNode.js";
import {
  ATTESTATION_TYPES,
  oracleDomain,
  signAttestation,
  toSolidityAttestation,
} from "../src/signer/attestation.js";
import { MarketSession } from "../src/types.js";
import { mulberry32 } from "../src/util/rng.js";
import { MockExchangeServer } from "../test/helpers/mockExchangeServer.js";

const MAX_QUOTE_AGE_MS = 2_000;

async function main() {
  const server = new MockExchangeServer();
  const baseUrl = await server.listen();
  console.log(`Local venues (real response shapes) listening at ${baseUrl}\n`);

  const feed = new AggregatedLiveFeed({
    symbol: "BTC-USD",
    adapters: [
      new CoinbaseAdapter(baseUrl),
      new KrakenAdapter(baseUrl),
      new BinanceAdapter(baseUrl),
      new GeminiAdapter(baseUrl),
      new BitstampAdapter(baseUrl),
    ],
    minSources: 3,
    pollIntervalMs: 300,
    maxQuoteAgeMs: MAX_QUOTE_AGE_MS,
    maxSpreadBps: 100,
    maxDeviationBps: 200,
    http: { timeoutMs: 2_000, retries: 1, retryBaseDelayMs: 20 },
    onEvent: (event) => {
      if (event.kind !== "aggregated") console.log(`  [feed] ${JSON.stringify(event)}`);
    },
  });

  await feed.start();
  const seed = feed.getSnapshot()!.price;
  console.log(`Seed price from ${feed.getSnapshot()!.sources.length} venues: ${seed}\n`);

  const engineConfig = {
    guardrails: { maxDeviationBpsLive: 200, maxDeviationBpsOffHours: 50 },
    liveBlendWeight: 0.5,
    offHoursVolatilityBpsPerTick: 5,
    skewInfluenceBps: 20,
    reconciliationSteps: 5,
  };

  const reporters = Array.from(
    { length: 3 },
    (_, i) => new ReporterNode(Wallet.createRandom(), seed, { ...engineConfig, random: mulberry32(1000 + i) }, 5)
  );

  const assetId = keccak256(toUtf8Bytes("BTC-USD"));
  const domain = oracleDomain(31337n, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  let nonce = 0n;

  console.log("Phase 1: all venues healthy, price drifting +10bps per tick");
  for (let i = 0; i < 5; i++) {
    for (const venue of Object.values(server.venues)) {
      venue.bid *= 1.001;
      venue.ask *= 1.001;
      venue.last *= 1.001;
    }
    await feed.poll();
    nonce = await runTick(feed, reporters, assetId, domain, nonce, i + 1);
    await sleep(60);
  }

  console.log("\nPhase 2: one venue starts printing 50x the others");
  server.venues.gemini.bid *= 50;
  server.venues.gemini.ask *= 50;
  await feed.poll();
  nonce = await runTick(feed, reporters, assetId, domain, nonce, 6);
  console.log("  -> the outlier is discarded; the published price barely moves");

  console.log("\nPhase 3: quorum lost (3 of 5 venues offline)");
  server.venues.coinbase.status = 503;
  server.venues.kraken.status = 503;
  server.venues.binance.status = 503;
  await feed.poll();
  console.log(`  cached price still served while fresh: ${feed.quote(new Date()) !== null}`);
  await sleep(MAX_QUOTE_AGE_MS + 200);
  const stale = feed.quote(new Date());
  console.log(`  past the staleness horizon, quote() returns: ${stale === null ? "null" : "a price"}`);
  nonce = await runTick(feed, reporters, assetId, domain, nonce, 7);
  console.log("  -> session flipped to OFF_HOURS: the engine falls back to its bounded");
  console.log("     synthetic model and the contract applies its tighter guardrail");

  feed.stop();
  await server.close();
}

async function runTick(
  feed: AggregatedLiveFeed,
  reporters: ReporterNode[],
  assetId: string,
  domain: ReturnType<typeof oracleDomain>,
  nonce: bigint,
  tickNumber: number
): Promise<bigint> {
  const now = new Date();
  const liveQuote = feed.quote(now);
  const timestamp = Math.floor(now.getTime() / 1000);

  const candidates = reporters.map((r) => r.observe({ liveQuote, inventorySkewBps: 0, now: timestamp }));
  const canonicalPrice = median(candidates);
  const session = liveQuote ? MarketSession.LIVE : MarketSession.OFF_HOURS;
  const nextNonce = nonce + 1n;

  const agreeing = reporters.filter((r) => r.agreesToSign(canonicalPrice, 25));
  const attestation = toSolidityAttestation(assetId, {
    price: canonicalPrice,
    timestamp,
    session,
    nonce: nextNonce,
    confidenceBps: session === MarketSession.LIVE ? 10 : 50,
  });

  const signatures = await Promise.all(agreeing.map((r) => signAttestation(r.wallet, domain, attestation)));
  const signaturesValid = signatures.every(
    (sig, i) => verifyTypedData(domain, ATTESTATION_TYPES, attestation, sig) === agreeing[i].wallet.address
  );

  const reference = liveQuote ? liveQuote.price.toFixed(4) : "(none)";
  console.log(
    `  tick ${tickNumber}: session=${MarketSession[session].padEnd(9)} ` +
      `ref=${reference.padStart(10)} ` +
      `oracle=${canonicalPrice.toFixed(4).padStart(10)} ` +
      `signers=${agreeing.length}/${reporters.length} sigsValid=${signaturesValid}`
  );

  for (const r of reporters) r.syncTo(canonicalPrice, timestamp, session, nextNonce);
  return nextNonce;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
