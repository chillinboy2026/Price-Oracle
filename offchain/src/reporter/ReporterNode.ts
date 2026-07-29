import { HDNodeWallet, Wallet } from "ethers";
import { EngineInputs, FairPriceEngine, FairPriceEngineConfig } from "../engine/FairPriceEngine.js";
import { deviationBps } from "../engine/Guardrails.js";
import { MarketSession } from "../types.js";
import { RandomFn } from "../util/rng.js";

/**
 * One independent reporter in the off-chain network. Each node runs its own
 * FairPriceEngine against its own (slightly noisy) view of the live feed --
 * simulating separate operators/data sources -- and only signs the
 * network's canonical (median-aggregated) price if it falls within this
 * node's own tolerance of what it independently observed. That refusal-to-
 * sign-outliers check is what makes the threshold-signature scheme actually
 * mean something: a reporter can't be forced to co-sign a price wildly
 * different from what it saw.
 */
export class ReporterNode {
  readonly wallet: Wallet | HDNodeWallet;
  private readonly engine: FairPriceEngine;
  private readonly observationNoiseBps: number;
  private readonly random: RandomFn;
  private lastCandidate: number | null = null;

  constructor(
    wallet: Wallet | HDNodeWallet,
    initialPrice: number,
    engineConfig: FairPriceEngineConfig,
    observationNoiseBps = 5
  ) {
    this.wallet = wallet;
    this.engine = new FairPriceEngine(initialPrice, engineConfig);
    this.observationNoiseBps = observationNoiseBps;
    this.random = engineConfig.random ?? Math.random;
  }

  /** Runs this node's own engine tick against a noised view of the shared
   * inputs and returns its candidate price. */
  observe(inputs: EngineInputs): number {
    const noisedInputs: EngineInputs = inputs.liveQuote
      ? {
          ...inputs,
          liveQuote: {
            ...inputs.liveQuote,
            price: inputs.liveQuote.price * (1 + ((this.random() * 2 - 1) * this.observationNoiseBps) / 10_000),
          },
        }
      : inputs;
    const result = this.engine.tick(noisedInputs);
    this.lastCandidate = result.price;
    return result.price;
  }

  agreesToSign(canonicalPrice: number, toleranceBps: number): boolean {
    if (this.lastCandidate === null) return false;
    return deviationBps(this.lastCandidate, canonicalPrice) <= toleranceBps;
  }

  /** Re-anchors this node's engine to the canonically published price so the
   * next tick blends from ground truth rather than this node's own private
   * (possibly slightly diverged) candidate. */
  syncTo(price: number, timestamp: number, session: MarketSession, nonce: bigint): void {
    this.engine.syncTo(price, timestamp, session, nonce);
  }
}
