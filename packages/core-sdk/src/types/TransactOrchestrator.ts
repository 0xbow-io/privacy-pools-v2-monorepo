import type { ZodType } from "zod";

import type {
    Address,
    EVMProof,
    Hash,
    Hex,
    IAddressEqualityComparator,
    IAddressFieldConverter,
    IASPClient,
    IContextHashService,
    ICryptoService,
    IKeystoreInteractor,
    IKeystoreManager,
    ILogger,
    INoteComputationService,
    INoteManager,
    IPayoutRoutingCodec,
    IPoolVaultInteractor,
    IProofService,
    IRelayBatchCodec,
    ITxReceiptWaiter,
    IWitnessPreparationService,
    Note,
    NoteData,
    PendingNote,
    PreparedTransaction,
    ResolvedTransferRecipient,
    TransactParams,
    TransactProof,
    TxLog,
} from "../internal.js";

/**
 * Configuration for TransactOrchestrator construction — shared deps for transfer + withdraw
 * flows, generic over the chain's prepared-transaction type `TTx`, address type `TAddress`, and
 * on-chain proof type `TProof`.
 */
export interface TransactOrchestratorConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    ownerAddress: TAddress;
    noteManager: INoteManager<TAddress>;
    keystoreManager: IKeystoreManager;
    witnessPreparationService: IWitnessPreparationService;
    proofService: IProofService<TProof>;
    keystoreInteractor: IKeystoreInteractor<TTx, TAddress>;
    poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>;
    aspClient: IASPClient;
    cryptoService: ICryptoService;
    noteComputationService: INoteComputationService;
    rpcInteractor: ITxReceiptWaiter<TLog>;
    /** Computes the proof-context hash bound into the transact circuit. */
    contextHashService: IContextHashService<TAddress>;
    /** Encodes/decodes the PayoutRouting tuple carried in `TransactParams.data`. */
    payoutRoutingCodec: IPayoutRoutingCodec<TAddress>;
    /** Encodes a batch of already-proven transact items into one relay-batch transaction. */
    relayBatchCodec: IRelayBatchCodec<TTx, TAddress, TProof>;
    /** Converts `TAddress` values into the field-sized `Hex` the Poseidon-hash layer expects. */
    addressFieldConverter: IAddressFieldConverter<TAddress>;
    /** Compares two `TAddress` values for equality (chain-specific canonicalization rules). */
    addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    /** Validates the `TAddress`-typed fields carried by this session's config. */
    addressSchema: ZodType<TAddress>;
}

/** Optional dependencies for TransactOrchestrator. */
export interface TransactOrchestratorDependencies {
    logger?: ILogger;
}

/**
 * Parameters for the unified prepareTransact pipeline, generic over the chain's address type
 * `TAddress`.
 */
export interface PrepareTransactParams<TAddress = Address> {
    /** Commitment hashes of the input notes to spend. */
    inputCommitments: Hash[];
    /** Amount to transfer to the recipient. */
    amount: Hex;
    /** Token identifier for the transferred asset. */
    tokenId: TAddress;
    /** Relay address. */
    relayAddress: TAddress;
    /** Fee amount to pay the relayer. */
    feeAmount: Hex;
    /** Address of the processor. */
    processorAddress: TAddress;
    /** Public withdrawal amount (0x0 for transfers). */
    amountOut: Hex;
    /**
     * Recipient address (relay address for transfers, actual recipient for
     * withdrawals). Only used to build the default `PayoutRouting` — ignored
     * when `transactParams` is provided.
     */
    recipientAddress: TAddress;
    /**
     * Native ETH the caller commits to forward via `PayoutRouting.nativeGas`.
     * Ignored when `transactParams` is provided. Defaults to `0x0`.
     */
    nativeGas?: Hex;
    /**
     * Optional override for `PayoutRouting.feeRecipient`. Falls back to
     * `relayAddress` when omitted; pass `EMPTY_ADDRESS` to defer to
     * `msg.sender` on-chain.
     */
    feeRecipient?: TAddress;
    /** Override transact params (used by relay flows with committed fee data). */
    transactParams?: TransactParams<TAddress>;
    /**
     * Resolved recipient identity. Omit for withdrawals.
     * The orchestrator publishes encrypted noteData only when `recipient.kind === "discoverable"`.
     */
    recipient?: ResolvedTransferRecipient;
    /**
     * When `true`, the owner's keystore leaf is not yet on-chain — this transact accompanies a
     * bundled `registerAndRelay`. The keystore membership proof is anchored to the PREDICTED
     * post-insertion root (owner's leaf appended at the next index) rather than the current root.
     * See {@link BuildTransactWitnessInputs.pendingKeystoreRegistration}.
     */
    pendingKeystoreRegistration?: boolean;
}

/**
 * Result of the unified prepareTransact pipeline, generic over the chain's prepared-transaction
 * type `TTx` and address type `TAddress`.
 */
export interface PrepareTransactResult<TTx = PreparedTransaction, TAddress = Address> {
    /** Change pending notes for the sender. */
    changePendingNotes: PendingNote<TAddress>[];
    /** Recipient pending notes (empty for withdrawals). */
    recipientPendingNotes: PendingNote<TAddress>[];
    /** The prepared transact transaction. */
    transactTx: TTx;
    /** Input notes to mark as SPENT on execution. */
    spentNotes: Note<TAddress>[];
    /**
     * Nullifier hashes the proof spends — `proof.publicSignals[0 : nInputs]`,
     * normalized to `0x`-hex. Parallel to `spentNotes` (same input order). Threaded
     * to {@link TransactOrchestratorConfig.persistNoteUpdates} so persistence can verify
     * the confirmed receipt's `Transacted` logs actually consumed these nullifiers
     * before marking the notes SPENT (AW-L-02 / #1070).
     */
    spentNullifiers: Hex[];
    /** Encrypted note data payloads. */
    notesData: NoteData[];
    /** The ZK proof result. */
    proof: TransactProof;
}

/**
 * Evidence a caller passes to {@link ITransactOrchestrator.persistNoteUpdates} so it
 * can confirm a relayer-supplied receipt actually spent the notes before persisting
 * them SPENT (AW-L-02 / #1070). Without this, a relayer could return the hash of an
 * unrelated successful transaction and the wallet would treat still-spendable notes
 * as spent.
 *
 * The check is verify-and-WARN, never a hard gate: on a mismatch persistence is
 * skipped with a warning and `discoverNotes()` remains the backstop, so a genuine
 * spend whose logs are merely unparseable (e.g. a proxied/wrapped call) is never
 * stranded by a throw.
 */
export interface SpentNoteVerification<TLog = TxLog> {
    /**
     * Nullifier hashes the proof committed to spending
     * ({@link PrepareTransactResult.spentNullifiers}), normalized to `0x`-hex.
     */
    expectedNullifiers: Hex[];
    /**
     * Raw event logs from the confirmed transaction receipt. Parsed for `Transacted`
     * events emitted by the expected PoolVault; every `expectedNullifiers` entry must
     * appear in an emitted `nullifierHashes` array.
     */
    receiptLogs: TLog[];
}

/**
 * One already-built transact, ready to be encoded into a `relayBatch` call, generic over the
 * chain's address type `TAddress`. Carries the raw proof (reshaped into the on-chain
 * `TransactProof` tuple at encode time) plus the routing and discovery data, and the proof's
 * input/output arity needed to slice its flat public signals into the on-chain layout.
 */
export interface RelayBatchItem<TAddress = Address> {
    /** The ZK proof result for this item. */
    proof: TransactProof;
    /** This item's ABI-encoded PayoutRouting params (processor + data). */
    transactParams: TransactParams<TAddress>;
    /** This item's encrypted note-data payloads. */
    noteData: NoteData[];
    /** Number of input notes this item spends (public-signal nullifier count). */
    nInputs: number;
    /** Number of output commitments this item creates (public-signal commitment count). */
    mOutputs: number;
}
