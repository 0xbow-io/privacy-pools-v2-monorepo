import type { ZodType } from "zod";

import type {
    Address,
    EVMProof,
    Hash,
    Hex,
    IAddressFieldConverter,
    IKeystoreInteractor,
    IKeystoreManager,
    ILogger,
    INoteManager,
    IPoolVaultInteractor,
    IPreparedTxVerifier,
    IProofService,
    ITxReceiptWaiter,
    IWitnessPreparationService,
    PreparedTransaction,
    TxLog,
} from "../internal.js";

/** Parameters for prepareRageQuit. */
export interface RageQuitParams {
    /** Commitment hash of the note to exit. Must not be EXITED, unless
     *  `allowUnconfirmedExit` says the caller knows better. */
    commitment: Hash;
    /**
     * Attempt the exit even when local status already says `EXITED`.
     *
     * The status check this waives is a convenience, not a safety property. The
     * chain is the arbiter: a nullifier can only be published once, so a note
     * that really was exited simply reverts on submission. What the check
     * cannot do is tell a real exit from a claimed one — an `EXITED` status can
     * be set from an unauthenticated ASP snapshot row, and because `EXITED` is
     * terminal, refusing on it locks the owner out of the one path that exists
     * to recover a note that is still perfectly spendable on chain. The refusal
     * is silent and permanent, which is the worst possible shape for a failsafe.
     *
     * Pass `true` ONLY for a note whose exit the caller has failed to
     * corroborate against the chain. It is opt-in precisely so the ordinary
     * "you already exited this" guard keeps protecting everyone else from
     * wasting gas.
     *
     * @default false
     */
    allowUnconfirmedExit?: boolean;
}

/**
 * Result of prepareRageQuit — returns an unsigned transaction without submitting, generic over
 * the chain's prepared-transaction type `TTx` and address type `TAddress`.
 */
export interface PrepareRageQuitResult<TTx = PreparedTransaction, TAddress = Address> {
    /** Echoed back so `executeRageQuit` (and external-broadcast flows via `markNotesExited`) can settle local state without separately tracking the input. */
    commitment: Hash;
    /** Full note value withdrawn (ragequit is always a full withdrawal). */
    value: Hex;
    /** Token identifier of the withdrawn asset. */
    tokenId: TAddress;
    /** Nullifier hash that will be published on-chain when submitted. */
    nullifierHash: Hash;
    /** The ownerAddress that will receive the funds. Enforced by the circuit. */
    recipientAddress: TAddress;
    /** The prepared ragequit transaction, ready to submit. */
    ragequitTx: TTx;
}

/**
 * Configuration for PoolSessionRagequit construction, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, and
 * raw receipt-log type `TLog`.
 */
export interface PoolSessionRagequitConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /** The account owner's address. */
    ownerAddress: TAddress;
    /** PoolVault interactor for encoding ragequit transactions. */
    poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>;
    /** Note state manager for reading note data. */
    noteManager: INoteManager<TAddress>;
    /** Key material provider for private nullifying and revocable keys. */
    keystoreManager: IKeystoreManager;
    /** Witness builder for the ragequit circuit. */
    witnessPreparationService: IWitnessPreparationService;
    /** ZK proof generator. */
    proofService: IProofService<TProof>;
    /** Keystore interactor for reading keystore tree leaves. */
    keystoreInteractor: IKeystoreInteractor<TTx, TAddress>;
    /** RPC interactor for on-chain reads and awaiting transaction receipts. */
    rpcInteractor: ITxReceiptWaiter<TLog>;
    /** Verifies prepared transactions target the expected contract/operation before signing. */
    preparedTxVerifier: IPreparedTxVerifier<TTx, TAddress>;
    /** Converts `TAddress` values into the field-sized `Hex` the Poseidon-hash layer expects. */
    addressFieldConverter: IAddressFieldConverter<TAddress>;
    /** Validates the `TAddress`-typed fields carried by this session's config. */
    addressSchema: ZodType<TAddress>;
}

/** Optional dependencies for PoolSessionRagequit. */
export interface PoolSessionRagequitDependencies {
    logger?: ILogger;
}
