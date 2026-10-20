import type {
    Address,
    DepositedEvent,
    EVMProof,
    Hash,
    Hex,
    NoteData,
    NoteEvent,
    RagequitEvent,
    TransactedEvent,
    TransactParams,
    TxLog,
} from "../internal.js";

/**
 * Chain-specific mechanics for `PoolVaultInteractor<TTx, TAddress, TProof, TLog>`: raw reads,
 * event fetch + decode, calldata/XDR encoding, and transaction submission. Everything
 * `PoolVaultInteractor` itself doesn't need to know to do its own job (leaf-cache bookkeeping,
 * input validation) lives here instead — see `PoolVaultInteractor`'s class doc for the split
 * rationale.
 *
 * - `TTx` is the chain's prepared-transaction type (EVM: {@link PreparedTransaction}; a future
 *   Stellar adapter: an unsigned transaction XDR string or similar) — opaque to
 *   `PoolVaultInteractor`, which only ever passes it from `encodeX` straight into `submit`.
 *   `encodeRagequit`/`encodeTransact` return `Promise<TTx>` (not `TTx` directly): EVM's ABI
 *   calldata encoding is pure/offline, but building a submittable Stellar transaction needs
 *   real RPC round-trips (account sequence number, simulation, resource-fee assembly) — EVM
 *   adapters just wrap their existing synchronous logic in an `async` method.
 * - `TAddress` is the chain's address type (defaults to EVM's {@link Address}).
 * - `TProof` is the chain's Groth16-proof-on-chain-calldata shape (defaults to {@link EVMProof});
 *   still assumes the caller already ran `AbstractProofService.formatForX` — generalizing this to
 *   take the chain-agnostic `ProofResult` and have the adapter format-for-chain internally
 *   requires touching orchestrator call sites (`PoolSessionRagequit`/`TransactOrchestrator`),
 *   which is out of scope for this milestone.
 * - `TLog` is the chain's raw receipt-log type (defaults to EVM's {@link TxLog}), consumed by
 *   `extractSpentNullifiers`.
 */
export interface IPoolVaultChainAdapter<TTx, TAddress = Address, TProof = EVMProof, TLog = TxLog> {
    /** The on-chain PoolVault contract address this adapter is bound to. */
    getAddress(): TAddress;

    /** Raw read of a commitment's insertion timestamp (0n if it does not exist). */
    getCommitmentValue(commitmentHash: Hash): Promise<bigint>;

    /** Raw read of a nullifier's spent timestamp (0n if unspent). */
    getNullifierValue(nullifierHash: Hash): Promise<bigint>;

    /** Raw read of whether a state root is in the root-history buffer. */
    isKnownRootRaw(root: Hash): Promise<boolean>;

    /** Current chain cursor (EVM: block number) — the upper bound for a leaf-delta fetch. */
    getCurrentCursor(): Promise<bigint>;

    /**
     * Resolves a note's field-converted `tokenId` (`IAddressFieldConverter.toTokenIdField`'s
     * output, as recovered from a note's decrypted payload during discovery) back to the chain's
     * real address type. EVM's conversion is the identity, so this is a trivial reformat; a
     * chain whose conversion is a one-way hash (Stellar's `keccak256(strkey) & mask`) has no
     * general inverse and must resolve it by cross-referencing cleartext on-chain data instead
     * (e.g. `Deposited` events' `asset` field) — returns `null` if the value doesn't match any
     * asset observed on-chain yet.
     */
    resolveTokenId(fieldValue: Hash): Promise<TAddress | null>;

    /**
     * Fetches and decodes leaf-insertion deltas in `[fromCursor, toCursor]`, already validated
     * into `{startIndex, newLeaves}` — `PoolVaultInteractor` merges these into its cache without
     * needing to know how they were fetched or decoded.
     */
    fetchLeafInsertions(
        fromCursor: bigint | undefined,
        toCursor: bigint,
    ): Promise<{ startIndex: number; newLeaves: Hash[] }[]>;

    fetchNoteEvents(fromCursor?: Hex, toCursor?: Hex): Promise<NoteEvent[]>;
    fetchTransactedEvents(fromCursor?: Hex, toCursor?: Hex): Promise<TransactedEvent<TAddress>[]>;
    fetchDepositedEvents(fromCursor?: Hex, toCursor?: Hex): Promise<DepositedEvent<TAddress>[]>;
    fetchRagequitEvents(fromCursor?: Hex, toCursor?: Hex): Promise<RagequitEvent<TAddress>[]>;

    /** Decodes the nullifier hashes this pool actually spent from a confirmed tx's raw logs. */
    extractSpentNullifiers(logs: TLog[]): Hex[];

    /**
     * @param proof - On-chain-formatted Groth16 proof.
     * @param asset - The asset being ragequit — EVM's PoolVault is single-asset-per-deployment
     *   and ignores this; a multi-asset chain (Stellar) needs it as an explicit call argument.
     */
    encodeRagequit(proof: TProof, asset: TAddress): Promise<TTx>;
    /**
     * @param asset - The asset being transacted — EVM's PoolVault is single-asset-per-deployment
     *   and ignores this; a multi-asset chain (Stellar) needs it as an explicit call argument.
     */
    /**
     * @param options.deferSimulation - The call cannot be simulated yet because it depends on
     *   state a bundled step will create first (a register-and-withdraw proof anchored to the
     *   PREDICTED post-registration keystore root). A chain that simulates while encoding (Soroban)
     *   builds the call unsimulated; the result is for inspection only — the relayer submits its
     *   own bundled call. EVM encodes calldata without simulating and ignores it.
     */
    encodeTransact(
        proof: TProof,
        transactPubSignals: bigint[][],
        transactParams: TransactParams<TAddress>,
        noteData: NoteData[],
        asset: TAddress,
        options?: { deferSimulation?: boolean },
    ): Promise<TTx>;

    /** Submits a prepared transaction through the attached wallet. */
    submit(tx: TTx): Promise<Hex>;
}
