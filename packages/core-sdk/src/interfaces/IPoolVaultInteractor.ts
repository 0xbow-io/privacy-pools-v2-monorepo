import type {
    Address,
    DepositedEvent,
    EVMProof,
    Hash,
    Hex,
    LeafCacheSeed,
    NoteData,
    NoteEvent,
    PreparedTransaction,
    RagequitEvent,
    TransactedEvent,
    TransactParams,
    TxLog,
} from "../internal.js";

/**
 * Interactions with the PoolVault contract, generic over the chain's prepared-transaction type
 * `TTx`, address type `TAddress`, and on-chain proof type `TProof` (all default to their EVM
 * shapes, so existing code typing against `IPoolVaultInteractor` with no type arguments is
 * unaffected).
 */
export interface IPoolVaultInteractor<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /**
     * Returns the contract address this interactor is bound to.
     *
     * @returns The on-chain PoolVault contract address.
     */
    getAddress(): TAddress;

    /**
     * The chain's current cursor (EVM: block number; Stellar: ledger sequence) — the upper bound
     * a caller would pass as `toBlock` to any of this interactor's event-fetch methods to scan
     * "up through now".
     *
     * @returns The current cursor.
     * @throws {ContractInteractorBaseError}
     */
    getCurrentCursor(): Promise<Hex>;

    /**
     * Resolves a note's field-converted `tokenId` back to the chain's real address type — see
     * `IPoolVaultChainAdapter.resolveTokenId`'s doc comment for why this can't always be a pure
     * reformat.
     *
     * @param fieldValue - The field-converted tokenId recovered from a note's decrypted payload.
     * @returns The resolved address, or `null` if unresolvable from on-chain data seen so far.
     * @throws {ContractInteractorBaseError}
     */
    resolveTokenId(fieldValue: Hash): Promise<TAddress | null>;

    /**
     * Reads the creation timestamp of a commitment.
     *
     * @param commitmentHash - The commitment hash to query.
     * @returns The block timestamp when the commitment was inserted, or 0n if it does not exist.
     * @throws {ContractInteractorBaseError}
     */
    getCommitmentTimestamp(commitmentHash: Hash): Promise<Hash>;

    /**
     * Reads the spent timestamp of a nullifier.
     *
     * @param nullifierHash - The nullifier hash to query.
     * @returns The block timestamp when the nullifier was spent, or 0n if unspent.
     * @throws {ContractInteractorBaseError}
     */
    getNullifierTimestamp(nullifierHash: Hash): Promise<Hash>;

    /**
     * Checks whether a Merkle root is in the PoolVault's root history buffer.
     *
     * @param root - The state root to verify.
     * @returns True if the root is recognized.
     * @throws {ContractInteractorBaseError}
     */
    isKnownRoot(root: Hash): Promise<boolean>;

    /**
     * Reconstructs all state tree leaves from on-chain LeafInserted/LeafUpdated events.
     *
     * @returns Ordered array of state tree leaf hashes.
     * @throws {ContractInteractorBaseError}
     */
    getStateLeaves(): Promise<Hash[]>;

    /**
     * Returns the current state-tree leaf cache state for external
     * persistence (e.g. to disk between test runs, or browser storage across
     * dApp sessions), or `undefined` if {@link getStateLeaves} has never been
     * called on this instance. Feed the result back in as `seed` on a future
     * instance's constructor dependencies to skip re-scanning the leaves it
     * already covers.
     *
     * @returns The current cache snapshot, or `undefined` if nothing cached yet.
     */
    exportLeafCache(): LeafCacheSeed | undefined;

    /**
     * Fetches Note events from the PoolVault contract and returns parsed NoteEvent objects.
     *
     * @param fromBlock - Start block (inclusive). Defaults to 0n.
     * @param toBlock - End block (inclusive). Defaults to 'latest'.
     * @returns Array of NoteEvent objects parsed from on-chain Note event logs.
     * @throws {ContractInteractorBaseError}
     */
    getNoteEvents(fromBlock?: Hex, toBlock?: Hex): Promise<NoteEvent[]>;

    /**
     * Fetches Transacted events from the PoolVault contract and returns parsed TransactedEvent objects.
     * Each event corresponds to a single successful transact call (transfer or withdraw).
     *
     * @param fromBlock - Start block (inclusive). Defaults to 0n.
     * @param toBlock - End block (inclusive). Defaults to 'latest'.
     * @returns Array of TransactedEvent objects parsed from on-chain Transacted event logs.
     * @throws {ContractInteractorBaseError}
     */
    getTransactedEvents(fromBlock?: Hex, toBlock?: Hex): Promise<TransactedEvent<TAddress>[]>;

    /**
     * Extracts the nullifier hashes this PoolVault actually spent in a confirmed
     * transaction, by decoding the receipt's raw `Transacted` logs that THIS pool
     * emitted. Logs emitted by any other contract are ignored, so the returned set
     * doubles as the emitter==PoolVault check when verifying a relayer-supplied
     * receipt before persisting notes SPENT (AW-L-02 / #1070). Malformed or
     * non-`Transacted` logs are skipped, never thrown on.
     *
     * @param logs - Raw event logs from a transaction receipt (`TxReceipt.logs`).
     * @returns Every nullifier hash from this pool's `Transacted` events, `0x`-hex.
     */
    extractSpentNullifiers(logs: TLog[]): Hex[];

    /**
     * Fetches Deposited events from the PoolVault contract and returns parsed DepositedEvent objects.
     * Each event corresponds to one deposit and one state-tree leaf insertion.
     *
     * @param fromBlock - Start block (inclusive). Defaults to 0n.
     * @param toBlock - End block (inclusive). Defaults to 'latest'.
     * @returns Array of DepositedEvent objects parsed from on-chain Deposited event logs.
     * @throws {ContractInteractorBaseError}
     */
    getDepositedEvents(fromBlock?: Hex, toBlock?: Hex): Promise<DepositedEvent<TAddress>[]>;

    /**
     * Fetches Ragequit events from the PoolVault contract and returns parsed RagequitEvent objects.
     * Each event corresponds to a single successful ragequit call.
     *
     * @param fromBlock - Start block (inclusive). Defaults to 0n.
     * @param toBlock - End block (inclusive). Defaults to 'latest'.
     * @returns Array of RagequitEvent objects parsed from on-chain Ragequit event logs.
     * @throws {ContractInteractorBaseError}
     */
    getRagequitEvents(fromBlock?: Hex, toBlock?: Hex): Promise<RagequitEvent<TAddress>[]>;

    /**
     * Encodes a ragequit transaction without sending.
     *
     * @param proof - EVM-formatted Groth16 proof.
     * @param asset - The asset being ragequit (ignored on a single-asset-per-deployment chain).
     * @returns A prepared transaction ready for submission.
     */
    encodeRagequit(proof: TProof, asset: TAddress): Promise<TTx>;

    /**
     * Encodes a transact (transfer/withdraw) transaction without sending.
     *
     * @param proof - EVM-formatted Groth16 proof (pubSignals field unused; use transactPubSignals instead).
     * @param transactPubSignals - Restructured 2D public signals array for the transact circuit.
     * @param transactParams - Processor routing parameters.
     * @param noteData - Encrypted note data payloads.
     * @param asset - The asset being transacted (ignored on a single-asset-per-deployment chain).
     * @returns A prepared transaction ready for submission.
     */
    encodeTransact(
        proof: TProof,
        transactPubSignals: bigint[][],
        transactParams: TransactParams<TAddress>,
        noteData: NoteData[],
        asset: TAddress,
        options?: { deferSimulation?: boolean },
    ): Promise<TTx>;

    /**
     * Sends a prepared transaction through the attached wallet.
     *
     * @param tx - The prepared transaction (to, data, value).
     * @returns The transaction hash.
     * @throws {ContractInteractorBaseError}
     */
    submitTransaction(tx: TTx): Promise<Hex>;
}
