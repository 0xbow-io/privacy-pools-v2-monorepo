import type {
    Address,
    DepositedEvent,
    EVMProof,
    Hash,
    Hex,
    IPoolVaultChainAdapter,
    IPoolVaultInteractor,
    LeafCacheSeed,
    NoteData,
    NoteEvent,
    PreparedTransaction,
    RagequitEvent,
    TransactedEvent,
    TransactParams,
    TxLog,
} from "../../internal.js";
import { bigintToHex, HexSchema, InvalidHashArgument } from "../../internal.js";

interface PoolVaultInteractorConfig<TTx, TAddress, TProof, TLog> {
    adapter: IPoolVaultChainAdapter<TTx, TAddress, TProof, TLog>;
    /** Earliest cursor to scan for contract events when no cache/seed exists. */
    deploymentBlock?: bigint;
}

interface PoolVaultInteractorSeedDependencies {
    /** Pre-populates the state-tree leaf cache — see {@link LeafCacheSeed}. */
    seed?: LeafCacheSeed;
}

/**
 * Interactions with a pool-vault-shaped contract, generic over the chain's prepared-transaction
 * type `TTx`, address type `TAddress`, and on-chain proof type `TProof`. Chain-specific mechanics
 * (reads, event fetch + decode, calldata/XDR encoding, submission) live entirely in the injected
 * {@link IPoolVaultChainAdapter} — this class owns only what's genuinely chain-agnostic: input
 * validation, error re-wrapping, and the state-tree leaf-cache bookkeeping (delta-merge,
 * in-flight-fetch coalescing). None of the three type parameters is ever inspected here, only
 * passed opaquely from `adapter.encodeX()`/reads into `adapter.submit()`/return values.
 *
 * Construct the EVM instantiation via `createEvmPoolVaultInteractor` (in
 * `EvmPoolVaultChainAdapter.ts`, not a static method here) — deliberately kept out of this file
 * so importing `PoolVaultInteractor` alone never pulls in viem/ABI constants for a bundle that
 * only ever uses a Stellar adapter. This class has no value-level dependency on any concrete
 * chain adapter, only the `IPoolVaultChainAdapter` type (erased at compile time). Existing
 * consumers typing against `IPoolVaultInteractor` (no type arguments) are unaffected, since that
 * interface defaults `TTx`/`TAddress`/`TProof` to their EVM shapes.
 */
export class PoolVaultInteractor<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements IPoolVaultInteractor<TTx, TAddress, TProof, TLog>
{
    private readonly adapter: IPoolVaultChainAdapter<TTx, TAddress, TProof, TLog>;
    private readonly deploymentBlock?: bigint;

    /**
     * State-tree leaf cache — instance-scoped, delta-fetched from `cachedToBlock + 1` instead of
     * re-scanning from `deploymentBlock` every call. A `PoolSessionBuilder` constructs exactly one
     * `PoolVaultInteractor` per session, bound to that session's own adapter — no pooling or reuse
     * across chains.
     */
    private cachedLeaves: Hash[] = [];
    private cachedToBlock?: bigint;
    /** In-progress {@link getStateLeaves} call, if any — shared by concurrent callers instead of racing two scans of the same range. */
    private inFlightFetch?: Promise<Hash[]>;

    constructor(
        config: PoolVaultInteractorConfig<TTx, TAddress, TProof, TLog>,
        deps?: PoolVaultInteractorSeedDependencies,
    ) {
        this.adapter = config.adapter;
        this.deploymentBlock = config.deploymentBlock;
        if (deps?.seed) {
            this.cachedLeaves = deps.seed.leaves.slice();
            this.cachedToBlock = deps.seed.toBlock;
        }
    }

    /** @inheritdoc IPoolVaultInteractor.getAddress */
    getAddress(): TAddress {
        return this.adapter.getAddress();
    }

    /** @inheritdoc IPoolVaultInteractor.getCurrentCursor */
    async getCurrentCursor(): Promise<Hex> {
        return `0x${(await this.adapter.getCurrentCursor()).toString(16)}` as Hex;
    }

    /** @inheritdoc IPoolVaultInteractor.resolveTokenId */
    async resolveTokenId(fieldValue: Hash): Promise<TAddress | null> {
        return this.adapter.resolveTokenId(fieldValue);
    }

    /** @inheritdoc IPoolVaultInteractor.getCommitmentTimestamp
     * @throws {InvalidHashArgument} When the commitment hash is not valid hex.
     */
    async getCommitmentTimestamp(commitmentHash: Hash): Promise<Hash> {
        const validated = HexSchema.safeParse(commitmentHash);
        if (!validated.success) {
            throw new InvalidHashArgument(validated.error.issues[0].message);
        }
        return bigintToHex(await this.adapter.getCommitmentValue(commitmentHash));
    }

    /** @inheritdoc IPoolVaultInteractor.getNullifierTimestamp
     * @throws {InvalidHashArgument} When the nullifier hash is not valid hex.
     */
    async getNullifierTimestamp(nullifierHash: Hash): Promise<Hash> {
        const validated = HexSchema.safeParse(nullifierHash);
        if (!validated.success) {
            throw new InvalidHashArgument(validated.error.issues[0].message);
        }
        return bigintToHex(await this.adapter.getNullifierValue(nullifierHash));
    }

    /** @inheritdoc IPoolVaultInteractor.isKnownRoot
     * @throws {InvalidHashArgument} When the root is not valid hex.
     */
    async isKnownRoot(root: Hash): Promise<boolean> {
        const validated = HexSchema.safeParse(root);
        if (!validated.success) {
            throw new InvalidHashArgument(validated.error.issues[0].message);
        }
        return this.adapter.isKnownRootRaw(root);
    }

    /** @inheritdoc IPoolVaultInteractor.getStateLeaves
     *
     * Delta-fetches from `cachedToBlock + 1` on every call after the first, instead of
     * re-scanning from `deploymentBlock` every time. Concurrent calls share the same
     * in-flight scan via `inFlightFetch`.
     */
    async getStateLeaves(): Promise<Hash[]> {
        if (this.inFlightFetch) {
            return this.inFlightFetch;
        }
        const fetchPromise = this.getStateLeavesFromEvents();
        this.inFlightFetch = fetchPromise;
        try {
            return await fetchPromise;
        } finally {
            if (this.inFlightFetch === fetchPromise) {
                this.inFlightFetch = undefined;
            }
        }
    }

    /** @inheritdoc IPoolVaultInteractor.exportLeafCache */
    exportLeafCache(): LeafCacheSeed | undefined {
        if (this.cachedToBlock === undefined) {
            return undefined;
        }
        return { toBlock: this.cachedToBlock, leaves: this.cachedLeaves.slice() };
    }

    /** @inheritdoc IPoolVaultInteractor.getNoteEvents */
    async getNoteEvents(fromBlock?: Hex, toBlock?: Hex): Promise<NoteEvent[]> {
        return this.adapter.fetchNoteEvents(fromBlock, toBlock);
    }

    /** @inheritdoc IPoolVaultInteractor.getTransactedEvents */
    async getTransactedEvents(fromBlock?: Hex, toBlock?: Hex): Promise<TransactedEvent<TAddress>[]> {
        return this.adapter.fetchTransactedEvents(fromBlock, toBlock);
    }

    /** @inheritdoc IPoolVaultInteractor.extractSpentNullifiers */
    extractSpentNullifiers(logs: TLog[]): Hex[] {
        return this.adapter.extractSpentNullifiers(logs);
    }

    /** @inheritdoc IPoolVaultInteractor.getDepositedEvents */
    async getDepositedEvents(fromBlock?: Hex, toBlock?: Hex): Promise<DepositedEvent<TAddress>[]> {
        return this.adapter.fetchDepositedEvents(fromBlock, toBlock);
    }

    /** @inheritdoc IPoolVaultInteractor.getRagequitEvents */
    async getRagequitEvents(fromBlock?: Hex, toBlock?: Hex): Promise<RagequitEvent<TAddress>[]> {
        return this.adapter.fetchRagequitEvents(fromBlock, toBlock);
    }

    /** @inheritdoc IPoolVaultInteractor.encodeRagequit */
    encodeRagequit(proof: TProof, asset: TAddress): Promise<TTx> {
        return this.adapter.encodeRagequit(proof, asset);
    }

    /** @inheritdoc IPoolVaultInteractor.encodeTransact */
    encodeTransact(
        proof: TProof,
        transactPubSignals: bigint[][],
        transactParams: TransactParams<TAddress>,
        noteData: NoteData[],
        asset: TAddress,
        options?: { deferSimulation?: boolean },
    ): Promise<TTx> {
        return this.adapter.encodeTransact(
            proof,
            transactPubSignals,
            transactParams,
            noteData,
            asset,
            options,
        );
    }

    /** @inheritdoc IPoolVaultInteractor.submitTransaction */
    async submitTransaction(tx: TTx): Promise<Hex> {
        return this.adapter.submit(tx);
    }

    /**
     * Reconstructs state leaves from the adapter's leaf-insertion deltas, merging them into the
     * cache. Only commits once the whole delta has parsed cleanly — a mid-parse throw must leave
     * the previous cache untouched so the next call retries the same range rather than skipping it.
     */
    private async getStateLeavesFromEvents(): Promise<Hash[]> {
        const currentCursor = await this.adapter.getCurrentCursor();
        const fromCursor =
            this.cachedToBlock !== undefined ? this.cachedToBlock + 1n : this.deploymentBlock;

        if (
            this.cachedToBlock !== undefined &&
            fromCursor !== undefined &&
            fromCursor > currentCursor
        ) {
            return this.cachedLeaves;
        }

        const deltas = await this.adapter.fetchLeafInsertions(fromCursor, currentCursor);

        const leaves: Hash[] = this.cachedLeaves.slice();
        for (const { startIndex, newLeaves } of deltas) {
            for (let i = 0; i < newLeaves.length; i++) {
                leaves[startIndex + i] = newLeaves[i];
            }
        }

        this.cachedLeaves = leaves;
        this.cachedToBlock = currentCursor;

        return leaves;
    }
}
