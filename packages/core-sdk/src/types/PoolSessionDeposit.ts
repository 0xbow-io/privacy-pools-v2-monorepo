import type { ZodType } from "zod";

import type {
    Address,
    EVMProof,
    Hex,
    IAddressEqualityComparator,
    IAddressFieldConverter,
    IASPClient,
    IContextHashService,
    ICryptoService,
    IEntrypointInteractor,
    IKeystoreInteractor,
    IKeystoreManager,
    ILogger,
    INoteComputationService,
    INoteManager,
    IPoolVaultInteractor,
    IPreparedTxVerifier,
    IProofService,
    ITxReceiptWaiter,
    IWitnessPreparationService,
    PendingNote,
    Secret,
    TxLog,
} from "../internal.js";

/**
 * Configuration for PoolSessionDeposit construction, generic over the chain's prepared-transaction
 * type `TTx`, address type `TAddress`, on-chain proof type `TProof`, and raw receipt-log type
 * `TLog` (all default to their EVM shapes).
 */
export interface PoolSessionDepositConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /** The depositor's address. */
    ownerAddress: TAddress;
    /** Crypto service for secret generation. */
    cryptoService: ICryptoService;
    /** Witness preparation service for building deposit witnesses. */
    witnessPreparationService: IWitnessPreparationService;
    /** Proof service for generating ZK proofs. */
    proofService: IProofService<TProof>;
    /** Entrypoint interactor for reading asset configuration. */
    entrypointInteractor: IEntrypointInteractor<TTx, TAddress, TProof>;
    /** NoteManager for tracking the deposit note. */
    noteManager: INoteManager<TAddress>;
    /** ASP client for encrypting ciphertext payloads. */
    aspClient: IASPClient;
    /** Keystore manager for viewing key access. */
    keystoreManager: IKeystoreManager;
    /** Note computation service for handling note computations. */
    noteComputationService: INoteComputationService;
    /** Keystore interactor for accessing on-chain keystore data. */
    keystoreInteractor: IKeystoreInteractor<TTx, TAddress>;
    /** PoolVault interactor for reading per-deposit on-chain state (e.g. commitment block timestamp). */
    poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>;
    /** RPC interactor for on-chain reads and awaiting transaction receipts. */
    rpcInteractor: ITxReceiptWaiter<TLog>;
    /** Computes the proof-context hash bound into the deposit circuit. */
    contextHashService: IContextHashService<TAddress>;
    /** Verifies prepared transactions target the expected contract/operation before signing. */
    preparedTxVerifier: IPreparedTxVerifier<TTx, TAddress>;
    /** Converts `TAddress` values into the field-sized `Hex` the Poseidon-hash layer expects. */
    addressFieldConverter: IAddressFieldConverter<TAddress>;
    /** Compares two `TAddress` values for equality (chain-specific canonicalization rules). */
    addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    /** Validates the `TAddress`-typed fields carried by this session's config and params. */
    addressSchema: ZodType<TAddress>;
}

/** Dependencies for PoolSessionDeposit construction. */
export interface PoolSessionDepositDependencies {
    logger?: ILogger;
}

/** Parameters for a single deposit, generic over the chain's address type `TAddress`. */
export interface DepositParams<TAddress = Address> {
    /** Token address (or NATIVE_ASSET_ADDRESS for ETH). */
    tokenId: TAddress;
    /** Amount in the token's smallest unit. */
    value: Hex;
}

/**
 * Discovery data for `prepareDepositFor`, generic over the chain's address type `TAddress`.
 *
 * Variant 1 (`evmAddress`): SDK fetches the recipient's viewing key from the on-chain
 * keystore, generates `noteSecret` if absent, and computes `noteAddressHash`. Unregistered
 * recipient (`viewingKey == 0x0`) throws `DepositRecipientViewingKeyUnregistered` by default;
 * pass `allowOutOfBandFallback: true` to opt into the silent downgrade where the SDK returns
 * the secret via `PrepareDepositResult.noteSecret` for off-chain delivery instead of an
 * on-chain announcement (caller is then responsible for handing it to the recipient — losing
 * it strands the deposited funds permanently; `pendingNote.noteAddressHash` names the note).
 * Mirrors `RecipientDiscoveryData`'s `evmAddress` variant (`types/PoolSessionTransfer.ts`).
 *
 * Variant 2 (`publicViewingKey`): caller provides the viewing key, noteAddressHash, and
 * noteSecret directly — used when the recipient's address is unknown.
 */
export type DepositForDiscoveryData<TAddress = Address> =
    | {
          evmAddress: TAddress;
          noteSecret?: Hex;
          allowOutOfBandFallback?: boolean;
      }
    | {
          publicViewingKey: Hex;
          noteAddressHash: Hex;
          noteSecret: Hex;
      };

/**
 * What a {@link NoteDataBuilder} is handed: the note the deposit is about to commit to, after the
 * SDK has fixed every field the proof binds (the label needs the final value and depositSecret).
 */
export interface NoteDataBuilderInput<TAddress = Address> {
    /** The deposit's token, as passed to the deposit (a yield share for a router deposit). */
    tokenId: TAddress;
    /** The committed note value (shares for a yield deposit). */
    value: Hex;
    /** The recipient's noteAddressHash the commitment is built on. */
    noteAddressHash: Hex;
    /** The deposit secret the label is derived from (the caller's when supplied). */
    depositSecret: Hex;
    /** Poseidon(precommitment, depositSecret). */
    label: Hex;
    /** The full commitment the deposit will insert. */
    commitment: Hex;
}

/**
 * Builds a blind deposit's `noteData` once the note is fixed. Used when the caller cannot know
 * the committed value in advance (a swap-and-deposit into a yield share sizes its shares inside
 * the SDK), but still has to bind its own announcement (e.g. a sender-recoverable claim backup)
 * into the proof context. Called once, synchronously, before proving.
 */
export type NoteDataBuilder<TAddress = Address> = (
    note: NoteDataBuilderInput<TAddress>,
) => { hint: Hex; data: Hex };

/**
 * The recipient half of {@link DepositForParams}: every `prepareDepositFor` form minus the token
 * and amount. Also accepted as `SwapAndDepositParams.recipient` and (as `YieldDepositForRecipient`)
 * by `prepareYieldDepositFor`, so a swap-and-deposit or yield deposit can be made for someone else.
 *
 * Either provide a pre-computed `noteAddressHash` (no note announcement, blind cold-start)
 * or `discoveryData` to enable on-chain note discovery for the recipient.
 */
export type DepositForRecipient<TAddress = Address> =
    | {
          /** Pre-computed noteAddressHash = Poseidon(recipientAddress, noteSecret). */
          noteAddressHash: Hex;
          discoveryData?: never;
          /**
           * Pre-built noteData payload. When provided the proof context is computed from
           * this noteData rather than EMPTY_NOTE_DATA, so the submitted noteData and the
           * context embedded in the proof stay in sync. Required when the caller needs to
           * substitute a custom payload (e.g. stealth-delivery note data) after proof
           * generation — submitting anything other than this exact noteData will trigger
           * PoolVault_ProofContextMismatch on-chain. May be a {@link NoteDataBuilder} when the
           * payload depends on a value the SDK sizes (yield shares).
           */
          noteData?: { hint: Hex; data: Hex } | NoteDataBuilder<TAddress>;
          /** Caller-supplied depositSecret. Must be provided together with noteData when
           *  the caller pre-computes the label to build the stealth payload. */
          depositSecret?: Hex;
      }
    | {
          noteAddressHash?: never;
          /** Discovery data for note announcement. */
          discoveryData: DepositForDiscoveryData<TAddress>;
          noteData?: never;
          depositSecret?: never;
      };

/**
 * Parameters for a deposit on behalf of a recipient, generic over the chain's address type
 * `TAddress`. See {@link DepositForRecipient} for the recipient forms.
 */
export type DepositForParams<TAddress = Address> = DepositParams<TAddress> &
    DepositForRecipient<TAddress>;

/**
 * Resolved parameters consumed by the internal deposit pipeline, generic over the chain's address
 * type `TAddress`.
 */
export type DepositInternalParams<TAddress = Address> = DepositParams<TAddress> & {
    /** Resolved noteAddressHash. */
    noteAddressHash: Hex;
    /** Recipient noteSecret used for note data encryption. Absent for blind cold-start. */
    noteSecret?: Secret;
    /** Recipient public viewing key used for note data encryption. Absent for blind cold-start. */
    publicViewingKey?: Hex;
    /** Recipient address — populates PendingNote.ownerAddress when known. */
    ownerAddress?: TAddress;
    /** Pre-built noteData to use verbatim (or a builder resolved once the note is fixed). When
     *  set, overrides EMPTY_NOTE_DATA and the context is derived from this noteData, ensuring
     *  the submitted call data stays in sync. */
    noteData?: { hint: Hex; data: Hex } | NoteDataBuilder<TAddress>;
    /** Caller-supplied depositSecret. When provided, label (and therefore commitment) is
     *  deterministic — the caller must have pre-computed the label and built noteData using
     *  the same depositSecret so the proof's public signals stay consistent. */
    depositSecret?: Secret;
};

/** A prepared (unsigned) transaction ready for wallet submission. */
export interface PreparedTransaction {
    to: Address;
    data: Hex;
    value: Hex;
}

/**
 * Result of preparing a deposit (calldata ready for wallet submission), generic over the chain's
 * prepared-transaction type `TTx` and address type `TAddress`.
 */
export interface PrepareDepositResult<TTx = PreparedTransaction, TAddress = Address> {
    /** Note data for deferred persistence. Present for self-deposits, absent for deposit-for. */
    pendingNote: PendingNote<TAddress>;
    /** The prepared deposit transaction, ready for submission. */
    depositTx: TTx;
    /**
     * Every ERC-20 approval to submit, in order, before the deposit. Usually one; two on a
     * token that requires a zero reset before re-approving (mainnet USDT) when a residual
     * allowance exists. Empty for native ETH or a sufficient allowance. Prefer this over
     * `approvalTx`.
     */
    approvalTxs: TTx[];
    /** The last of `approvalTxs`, or null if none — kept for callers that submit a single approval. Always null for native ETH. */
    approvalTx: TTx | null;
    /**
     * Present only when `prepareDepositFor`'s `discoveryData.evmAddress` recipient had no
     * registered viewing key and `allowOutOfBandFallback` was set — no on-chain announcement
     * was published (`pendingNote.noteAddressHash` names the note; this is the secret needed
     * to spend it). The caller MUST deliver it to the recipient out-of-band; losing it strands
     * the deposited funds permanently. Absent whenever the recipient is discoverable on-chain —
     * that's the signal a caller needs to check.
     */
    noteSecret?: Hex;
}
