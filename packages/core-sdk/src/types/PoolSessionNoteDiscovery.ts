// NOTE (core-sdk split): the original packages/sdk/src/types/PoolSessionNoteDiscovery.ts typed
// `DiscoverNotesParams.stealthDepositCredentials` concretely as the stealth module's
// `ScanCredentials`. Widened to `unknown` here (see the field's own doc below) since core-sdk
// can't depend on the EVM-only stealth module; the sdk original stays as reference for
// evm-sdk's own narrower `EvmDiscoverNotesParams` (or equivalent), not yet extracted.
import type {
    Address,
    Contact,
    EVMProof,
    Hash,
    Hex,
    IAddressFieldConverter,
    IASPClient,
    IASPDataProvider,
    IKeystoreManager,
    IRPCInteractor,
    ILogger,
    INoteComputationService,
    INoteDiscoveryService,
    INoteManager,
    IPaymentRequestService,
    IPoolVaultInteractor,
    PreparedTransaction,
    TxLog,
} from "../internal.js";

/** Configuration for PoolSessionNoteDiscovery construction. */
/**
 * The fields note-status reconciliation reads from a transact, whatever the
 * source: a chain `Transacted` log or an ASP snapshot row.
 *
 * The nullifiers and commitments are required — they are what identifies the
 * spend. `blockNumber` is nullable because it is only the `spentAtBlock` stamp and
 * the reader falls back to the scan's own `fromBlock`; a snapshot row that arrives
 * without a usable one is still a spend, and dropping it would leave the note
 * ACTIVE and invite the user to spend it twice.
 */
export interface StatusTransact {
    outputCommitments: Hex[];
    nullifierHashes: Hex[];
    blockNumber: Hex | null;
}

/** The fields note-status reconciliation reads from a ragequit. See {@link StatusTransact}. */
export interface StatusRagequit {
    commitment: Hex;
    blockNumber: Hex | null;
    txHash: Hash | null;
}

/**
 * Configuration for PoolSessionNoteDiscovery construction, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, and
 * raw receipt-log type `TLog`.
 */
export interface PoolSessionNoteDiscoveryConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /** The account owner's address. */
    ownerAddress: TAddress;
    /** NoteDiscoveryService for scanning events. */
    noteDiscoveryService: INoteDiscoveryService<TAddress>;
    /** NoteManager for tracking discovered notes. */
    noteManager: INoteManager<TAddress>;
    /** KeystoreManager for viewing key access. */
    keystoreManager: IKeystoreManager;
    /**
     * Finality reader for the ragequit/`EXITED` status head: only settled blocks may write a
     * terminal status. Optional — a chain whose RPC interactor cannot report finality (or a
     * caller that supplies none) is treated as `unsupported`, the same weaker rule a provider
     * that does not serve the `finalized` tag gets.
     */
    rpcInteractor?: Pick<IRPCInteractor, "getFinalizedBlockNumber">;
    /** PoolVaultInteractor for fetching on-chain events (including the current cursor). */
    poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>;
    /** NoteComputationService for computing note addresses. */
    noteComputationService: INoteComputationService;
    /** Converts `TAddress` values into the field-sized `Hex` the Poseidon-hash layer expects. */
    addressFieldConverter: IAddressFieldConverter<TAddress>;
    /** HTTP data provider for the ASP (used for fetching event data in targeted discovery). */
    aspDataProvider: IASPDataProvider;
    /**
     * Root-verifying ASP client. Used to corroborate a `rejected` label status against the
     * association set before demoting a note (#540). Distinct from `aspDataProvider`: the raw
     * provider returns whatever the endpoint currently serves, whereas `getAssociationSetLeaves()`
     * rebuilds the LeanIMT root and asserts it against the on-chain `latestASPRoot` — so a stale
     * or mid-rebuild snapshot is rejected instead of being taken as independent confirmation of
     * the rejection it is supposed to corroborate.
     */
    aspClient: IASPClient;
    /**
     * Payment-request service. Discovery runs `scanPaymentRequests` against open requests
     * alongside catch-all when no contacts are provided, and marks fulfilled requests
     * after persisting matching notes.
     */
    paymentRequestService: IPaymentRequestService;
}

/** Dependencies for PoolSessionNoteDiscovery construction. */
export interface PoolSessionNoteDiscoveryDependencies {
    logger?: ILogger;
}

/** Parameters for phantom-note purge. */
export interface PurgePhantomNotesParams {
    /**
     * When `true`, runs the entire scan (ASP snapshot, chain-tail catch-up,
     * per-candidate on-chain double-check) and returns the would-purge set
     * without mutating the NoteManager or storage adapter.
     *
     * Useful for previewing the impact before running destructively.
     */
    dryRun?: boolean;
}

/** Parameters for note discovery. */
export interface DiscoverNotesParams {
    /**
     * Optional starting block for event scanning.
     * If provided, overrides the NoteManager's sync cursor.
     * If omitted, uses the NoteManager's current sync cursor.
     */
    fromBlock?: Hex;
    /**
     * Known contacts with their viewing public keys.
     * If provided, runs targeted discovery: computes shared secrets only for these contacts,
     * then filters events by expected tags.
     * If omitted, runs catch-all: attempts ECDH + decrypt against every anonymous transfer event.
     */
    contacts?: Contact[];
    /**
     * Scan credentials for stealth-owned deposits (currently only the cross-chain-reshield
     * dust-rescue flow, see {@link INoteDiscoveryService.scanStealthDeposits}). Opaque here —
     * only meaningful when `noteDiscoveryService` implements the optional
     * `scanStealthDeposits`, which defines and casts to its own chain-specific credentials
     * shape (e.g. evm-sdk's `ScanCredentials`). Omitted by default — most accounts never opt
     * into dust rescue, so this scan is opt-in rather than run unconditionally on every
     * discovery pass.
     */
    stealthDepositCredentials?: unknown;
}
