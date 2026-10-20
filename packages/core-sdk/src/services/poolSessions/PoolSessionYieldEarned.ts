import type {
    Address,
    Hex,
    IKeystoreManager,
    ILogger,
    INoteComputationService,
    INoteManager,
    IPoolSessionYieldEarned,
    IYieldTokenInteractor,
    PoolSessionYieldEarnedConfig,
    PoolSessionYieldEarnedDependencies,
    YieldDeploymentConfig,
    YieldEarned,
    YieldEarnedInput,
    YieldEarnedNote,
} from "../../internal.js";
import { computeYieldEarned, MIN_PLAUSIBLE_NOTE_TIMESTAMP } from "../../internal.js";

/**
 * {@link IPoolSessionYieldEarned} implementation, chain-agnostic: reduces the wallet's notes of one
 * share to the flow inputs {@link computeYieldEarned} needs, reads the live exchange rate, and
 * computes. The only request it makes is the no-argument `exchangeRate()`.
 */
export class PoolSessionYieldEarned<TAddress = Address> implements IPoolSessionYieldEarned {
    private readonly deployment: YieldDeploymentConfig<TAddress>;
    private readonly noteManager: INoteManager<TAddress>;
    private readonly keystoreManager: IKeystoreManager;
    private readonly noteComputationService: INoteComputationService;
    private readonly yieldToken: IYieldTokenInteractor<TAddress>;
    private readonly logger?: ILogger;

    constructor(config: PoolSessionYieldEarnedConfig<TAddress>, deps?: PoolSessionYieldEarnedDependencies) {
        this.deployment = config.deployment;
        this.noteManager = config.noteManager;
        this.keystoreManager = config.keystoreManager;
        this.noteComputationService = config.noteComputationService;
        this.yieldToken = config.yieldToken;
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionYieldEarned.compute
     */
    async compute(input: YieldEarnedInput): Promise<YieldEarned> {
        // The feeds key shares by their wire string; `computeYieldEarned` is typed over EVM's
        // Address only because the feeds were EVM-first — the value is compared, never parsed.
        const share = this.deployment.shareToken as unknown as Address;
        const notes = this.reduceNotes(String(share));
        // The only request this method makes: public, no argument, every call.
        const exchangeRateNow = await this.yieldToken.exchangeRate();

        const result = computeYieldEarned({
            share,
            shareDecimals: this.deployment.shareDecimals,
            notes,
            depositFacts: input.depositFacts,
            rateSeries: input.rateSeries,
            events: input.events,
            exchangeRateNow,
            now: input.now ?? Math.floor(Date.now() / 1000),
        });

        // Status and reason only: the result carries the wallet's flows.
        this.logger?.debug("Yield earned computed", {
            share,
            notes: notes.length,
            status: result.status,
            reason: result.status === "unavailable" ? result.reason : undefined,
        });
        return result;
    }

    private reduceNotes(share: string): YieldEarnedNote[] {
        const shareKey = share.toLowerCase();
        const nullifyingKey = this.keystoreManager.getPrivateNullifyingKey();
        return this.noteManager
            .getNotes()
            .filter((note) => note.isOwned && String(note.tokenId).toLowerCase() === shareKey)
            .map((note) => ({
                commitment: note.commitment,
                nullifier: this.noteComputationService.computeNullifier(nullifyingKey, note.commitment),
                shares: BigInt(note.value),
                status: note.status,
                createdAt: noteTimestamp(note.createdAtBlock),
                originatedHere: note.depositSecret !== undefined,
            }));
    }
}

/**
 * A note's creation time in unix seconds, or null when `createdAtBlock` is not a plausible
 * timestamp (a block/ledger number, or garbage) — which makes the earned figure unavailable
 * rather than wrong.
 */
export function noteTimestamp(createdAtBlock: Hex): number | null {
    let value: bigint;
    try {
        value = BigInt(createdAtBlock);
    } catch {
        return null;
    }
    if (value < BigInt(MIN_PLAUSIBLE_NOTE_TIMESTAMP)) return null;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
}
