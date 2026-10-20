import type {
    Address,
    EVMProof,
    Hash,
    Note,
    PendingNote,
    PreparedTransaction,
    PrepareTransactParams,
    PrepareTransactResult,
    RelayBatchItem,
    SpentNoteVerification,
    TxLog,
} from "../internal.js";

/**
 * Shared transact infrastructure consumed by PoolSessionTransfer and PoolSessionWithdraw.
 * Generic over the chain's prepared-transaction type `TTx`, address type `TAddress`,
 * on-chain proof type `TProof`, and raw receipt-log type `TLog` (all default to their EVM
 * shapes). `TProof` isn't referenced by this interface's own methods — proof-taking methods live
 * on `IPoolVaultInteractor` — but is declared here so implementers/consumers threading an
 * injected `IPoolVaultInteractor<TTx, TAddress, TProof>` can stay arity-consistent.
 */
export interface ITransactOrchestrator<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /** The account owner's address. */
    readonly ownerAddress: TAddress;
    /** The PoolVault contract address. */
    readonly poolAddress: TAddress;

    /** Submits a prepared transaction to the PoolVault. */
    submit(tx: TTx): Promise<Hash>;

    /** Unified transact pipeline: resolves inputs, builds outputs, generates witness + proof. */
    prepareTransact(
        params: PrepareTransactParams<TAddress>,
    ): Promise<PrepareTransactResult<TTx, TAddress>>;

    /**
     * Resolves once the keystore AND state-tree leaf caches backing
     * `prepareTransact()`'s Merkle-proof step are fully populated (see
     * `KeystoreInteractor.getKeystoreLeaves()` and
     * `PoolVaultInteractor.getStateLeaves()`). A session already kicks both
     * scans off in the background at build time (`PoolSessionBuilder.ts`);
     * callers that are about to request a relayer-signed, time-boxed fee
     * commitment should `await` this first so the commitment's clock only
     * starts ticking once both scans are done, instead of racing them — a
     * cold from-`deploymentBlock` scan can otherwise burn enough of a
     * short-lived commitment's TTL to expire it (`FeeCommitmentExpired`)
     * before proof generation even starts.
     */
    warmMerkleCaches(): Promise<void>;

    /**
     * Marks input notes SPENT, adds the new output notes, and flushes the result to storage.
     * Callers MUST await it before reporting success: the flush is what makes a spend durable,
     * so an early return would let a crash leave a spent note looking ACTIVE on next start.
     *
     * `verification` is REQUIRED, not optional. Every caller persists on the strength of a
     * receipt it did not itself author (a relayer's txHash, or a self-submitted one), so the
     * confirmed receipt's `Transacted` logs are parsed and every `expectedNullifiers` entry must
     * appear in a log emitted by the expected PoolVault before anything is persisted. On a
     * mismatch the method WARNS and persists nothing — never throws — leaving `discoverNotes()`
     * as the backstop (AW-L-02 / #1070).
     *
     * It is deliberately required rather than optional: `SPENT` is a terminal state in the
     * note-status transition table, so a wrongly-persisted SPENT can never be walked back by
     * discovery. An optional parameter made the check fail-OPEN, and two relayed swap paths
     * silently skipped it. A required parameter turns any future miss into a compile error.
     */
    persistNoteUpdates(
        inputCommitments: Note<TAddress>[],
        pendingOutputNotes: PendingNote<TAddress>[],
        txHash: Hash,
        verification: SpentNoteVerification<TLog>,
    ): Promise<boolean>;

    /**  Prepare recipient notes to return */
    prepareRecipientNotes(
        recipientNotes: PendingNote<TAddress>[],
        txHash: Hash,
    ): Promise<Note<TAddress>[]>;

    /**
     * Encodes calldata for `PrivacyPoolRelay.relayBatch` from a set of already-built transact
     * items — the array form of a single `transact`. Used by the self-submit batch path where a
     * gas-paying user submits their own atomic batch (zero relayer fee) instead of routing
     * through a relayer.
     *
     * @param relayAddress - The PrivacyPoolRelay contract address (the transaction target).
     * @param items - One built proof + routing + discovery-data entry per batch item.
     * @param asset - The asset every item withdraws (see {@link IRelayBatchCodec.encodeRelayBatch}).
     * @returns The prepared `relayBatch` transaction (value `0x0`; the caller pays gas).
     */
    encodeRelayBatch(relayAddress: TAddress, items: RelayBatchItem<TAddress>[], asset: TAddress): Promise<TTx>;
}
