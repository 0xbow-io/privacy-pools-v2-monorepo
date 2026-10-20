import type { ZodType } from "zod";

import type {
    Address,
    EVMProof,
    Hash,
    Hex,
    IAddressFieldConverter,
    ICryptoService,
    IKeystoreInteractor,
    ILogger,
    INoteComputationService,
    IPaymentRequestService,
    IPreparedTxVerifier,
    IRelayerInteractor,
    ITransactOrchestrator,
    ITxReceiptWaiter,
    Label,
    Note,
    PendingNote,
    PrepareTransactBase,
    PreparedTransaction,
    PublicKey,
    RelayerInfo,
    Secret,
    TransferRelayerQuote,
    TxLog,
    TxReceipt,
} from "../internal.js";

/**
 * Configuration for PoolSessionTransfer construction, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, and
 * raw receipt-log type `TLog`.
 */
export interface PoolSessionTransferConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /** The sender's address. */
    ownerAddress: TAddress;
    /** Shared transact infrastructure (notes, keys, witness, proof, vault). */
    core: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    /** Relayer interactor for transfer-specific quote/submit endpoints. */
    relayerInteractor: IRelayerInteractor<TAddress>;
    /** RPC interactor for waiting on relay submissions. */
    rpcInteractor: ITxReceiptWaiter<TLog>;
    /** Crypto service for note secret generation. */
    cryptoService: ICryptoService;
    /** Note computation service for note address hash calculation. */
    noteComputationService: INoteComputationService;
    /** Keystore interactor for resolving recipient viewing keys from EVM addresses. */
    keystoreInteractor: IKeystoreInteractor<TTx, TAddress>;
    /** Payment-request service for recipient-side request management and sender-side fulfillment. */
    paymentRequestService: IPaymentRequestService;
    /** Verifies prepared transactions target the expected contract/operation before signing. */
    preparedTxVerifier: IPreparedTxVerifier<TTx, TAddress>;
    /** Converts `TAddress` values into the field-sized `Hex` the Poseidon-hash layer expects. */
    addressFieldConverter: IAddressFieldConverter<TAddress>;
    /** Validates the `TAddress`-typed fields carried by this session's per-call params. */
    addressSchema: ZodType<TAddress>;
}

/** Optional dependencies for PoolSessionTransfer. */
export interface PoolSessionTransferDependencies {
    logger?: ILogger;
}

/**
 * Recipient identity supplied by the caller, mirroring {@link DepositForDiscoveryData}, generic
 * over the chain's address type `TAddress`.
 *
 * - Variant 1 (`evmAddress`): SDK fetches the recipient's viewing key from the on-chain
 *   keystore. Unregistered recipient (`viewingKey == 0x0`) throws
 *   `RecipientViewingKeyUnregistered` by default; pass
 *   `allowOutOfBandFallback: true` to opt into the silent downgrade where
 *   the SDK returns secrets via `recipientNotes` for off-chain delivery
 *   (caller is then responsible for handing them to the recipient).
 *   `noteSecretsMap` is generated when absent. Caller-supplied maps on this
 *   variant are validated against the EVM address before any commitment is built.
 * - Variant 2 (`publicViewingKey` + `noteSecretsMap`): caller pre-resolved the viewing key and the
 *   noteSecretsMap; the SDK publishes encrypted noteData directly.
 *   The optional `hint` field overrides the default catch-all (`ANONYMOUS_HINT`) on
 *   the emitted event.
 *
 *   **CALLER-VERIFIED INVARIANT (publicViewingKey + noteSecretsMap variant):** every
 *   `noteSecretsMap` key MUST equal
 *   `Poseidon(recipientEvmAddress, noteSecret)`. The SDK cannot enforce
 *   this here because no EVM address is supplied. A malformed map produces
 *   on-chain commitments the recipient cannot reconstruct, locking the
 *   funds with no recovery path. Honest builders (e.g.
 *   {@link IPaymentRequestService.generate}) satisfy the invariant by
 *   construction; only hand-built maps are at risk.
 * - Variant 3 (`publicViewingKey` + `noteAddressHashes`): payment-request fulfillment.
 *   The caller has only the recipient's pre-committed `noteAddressHash` slots — never the
 *   secrets (those stay recipient-local). The SDK publishes a no-secret v2 noteData payload;
 *   the recipient reconstructs the spendable note from its local map at discovery. `hint` is
 *   set to `paymentRequest.tag`.
 */
export type RecipientDiscoveryData<TAddress = Address> =
    | {
          evmAddress: TAddress;
          noteSecretsMap?: Map<Hash, Secret>;
          hint?: never;
          allowOutOfBandFallback?: boolean;
      }
    | { publicViewingKey: PublicKey; noteSecretsMap: Map<Hash, Secret>; hint?: Hex }
    | {
          publicViewingKey: PublicKey;
          noteAddressHashes: Hash[];
          hint?: Hex;
          noteSecretsMap?: never;
          evmAddress?: never;
      };

/**
 * Resolved recipient identity consumed by the orchestrator and execute/relay paths.
 *
 * Pure crypto material — discriminated by field presence (no `kind` tag):
 * - **blind**: only `noteAddressHash`. No announcement, no out-of-band data.
 * - **outOfBand**: `noteSecretsMap` present, `publicViewingKey` absent. Secrets known but no
 *   public viewing key — no announcement; secrets returned to the caller for off-chain
 *   delivery (cold-start or auto-fallback).
 * - **discoverable**: both `noteSecretsMap` and `publicViewingKey` present. Encrypted
 *   noteData is published on-chain.
 * - **discoverable-without-secrets**: `publicViewingKey` present, `noteSecretsMap` absent
 *   (payment-request fulfillment). Encrypted v2 noteData is published on-chain carrying the
 *   `noteAddressHash` instead of the secret; the recipient holds the secret locally. The
 *   discriminant against **blind** is `publicViewingKey` presence.
 *
 * The recipient's EVM address (when known) is carried separately on
 * {@link ExecuteTransferParams} / {@link RelayTransferParams} as ownership-stamping metadata.
 */
export type ResolvedTransferRecipient =
    | {
          noteAddressHash: Hash[];
          /**
           * Authoritative label → hash mapping for the blind variant when the
           * caller used the {@link TransferParams.recipientNoteAddressHashByLabel}
           * input. When present, the orchestrator looks up by label name and
           * ignores positional ordering. Absent for the deprecated positional
           * array path.
           */
          noteAddressHashByLabel?: Map<Label, Hash>;
          noteSecretsMap?: never;
          publicViewingKey?: never;
          hint?: never;
      }
    | {
          noteAddressHash: Hash[];
          noteAddressHashByLabel?: never;
          noteSecretsMap: Map<Hash, Secret>;
          publicViewingKey?: never;
          hint?: never;
      }
    | {
          noteAddressHash: Hash[];
          noteAddressHashByLabel?: never;
          noteSecretsMap: Map<Hash, Secret>;
          publicViewingKey: PublicKey;
          hint?: Hex;
      }
    | {
          // discoverable-without-secrets (payment request): publicViewingKey present,
          // noteSecretsMap absent — the recipient holds the secrets locally.
          noteAddressHash: Hash[];
          noteAddressHashByLabel?: never;
          noteSecretsMap?: never;
          publicViewingKey: PublicKey;
          hint?: Hex;
      };

/** Parameters for prepareTransfer, generic over the chain's address type `TAddress`. */
export type TransferParams<TAddress = Address> = PrepareTransactBase<TAddress> &
    (
        | {
              /**
               * @deprecated Positional `Hash[]` whose indices must align with the
               * SDK's internal first-occurrence label iteration — an undocumented
               * contract that silently corrupts recipient discovery when violated.
               * Prefer {@link recipientNoteAddressHashByLabel}, which keys by
               * label and removes the ordering footgun.
               *
               * Pre-computed noteAddressHash for each recipient note:
               * `Poseidon(recipientAddress, noteSecret)`.
               */
              recipientNoteAddressHash: Hash[];
              recipientNoteAddressHashByLabel?: never;
              recipientDiscoveryData?: never;
          }
        | {
              recipientNoteAddressHash?: never;
              /**
               * Pre-computed noteAddressHash keyed by input label. Keys MUST be
               * the exact set of unique labels present in `inputCommitments`.
               * Values are `Poseidon(recipientAddress, noteSecret)`. Resolves to
               * the **blind** variant.
               */
              recipientNoteAddressHashByLabel: Map<Label, Hash>;
              recipientDiscoveryData?: never;
          }
        | {
              recipientNoteAddressHash?: never;
              recipientNoteAddressHashByLabel?: never;
              /** Recipient identity for on-chain note announcement. */
              recipientDiscoveryData: RecipientDiscoveryData<TAddress>;
          }
    );

/**
 * Parameters for a cold start transfer to a non-registered recipient, generic over the chain's
 * address type `TAddress`.
 */
export type ColdStartTransferParams<TAddress = Address> = PrepareTransactBase<TAddress> & {
    /** The recipient's address. noteAddressHash is computed internally. */
    recipientEvmAddress: TAddress;
};

/** Result of prepareTransfer — split into the two execution paths. */
export interface PrepareTransferResult<TTx = PreparedTransaction, TAddress = Address> {
    /** Self-submit payload for {@link IPoolSessionTransfer.executeTransfer}. */
    executeOptions: ExecuteTransferParams<TTx, TAddress>;
    /** Per-relayer payloads for {@link IPoolSessionTransfer.relayTransfer}. */
    relayOptions: RelayTransferParams<TAddress>[];
}

/**
 * Self-submit payload returned by prepareTransfer, generic over the chain's prepared-transaction
 * type `TTx` and address type `TAddress`.
 */
export interface ExecuteTransferParams<TTx = PreparedTransaction, TAddress = Address> {
    /** The prepared transact transaction. */
    transactTx: TTx;
    /** Notes to mark as SPENT on execution. */
    spentNotes: Note<TAddress>[];
    /**
     * Nullifier hashes of the spent notes (the proof's leading `nInputs` public signals),
     * threaded into {@link IPoolSessionTransfer.executeTransfer} so the post-tx persist can
     * confirm the receipt's PoolVault `Transacted` logs actually consumed them before marking
     * SPENT (AW-L-02 / #1070). Parallel to {@link spentNotes}.
     */
    spentNullifiers: Hex[];
    /** Pending notes of the sender's change (remainder after transfer). */
    changePendingNotes: PendingNote<TAddress>[];
    /** Pending notes for the recipient. Enriched with noteSecret + ownerAddress when the variant carries secrets. */
    recipientPendingNotes: PendingNote<TAddress>[];
    /** Resolved recipient state — used by executeTransfer to tag ownership. */
    recipient: ResolvedTransferRecipient;
    /** Recipient's address — stamped onto the returned recipient notes' `ownerAddress` when known. */
    recipientEvmAddress?: TAddress;
}

/** Per-relayer payload returned by prepareTransfer, generic over the chain's address type `TAddress`. */
export type RelayTransferParams<TAddress = Address> = PrepareTransactBase<TAddress> & {
    /** Resolved recipient state — same kind as {@link ExecuteTransferParams.recipient}. */
    recipient: ResolvedTransferRecipient;
    /** Recipient's address — stamped onto the returned recipient notes' `ownerAddress` when known. */
    recipientEvmAddress?: TAddress;
    /** Selected relayer quote. */
    selectedQuote: PrepareTransferRelayerQuotes<TAddress>;
};

export interface PrepareTransferRelayerQuotes<TAddress = Address> {
    /** Relayer information (name, URL, etc.) */
    relayerInfo: RelayerInfo<TAddress>;
    /** The fee quote returned by the relayer for this transfer. */
    quote: TransferRelayerQuote<TAddress>;
}

export interface TransferResult<TAddress = Address, TLog = TxLog> {
    txReceipt: TxReceipt<TLog>;
    recipientNotes?: Note<TAddress>[];
    /**
     * Did the confirmed receipt's PoolVault `Transacted` logs actually consume every
     * nullifier this transfer prepared?
     *
     * `false` means the receipt succeeded but it is NOT this transfer. The canonical
     * case is the one this verification was added for (AW-L-02 / #1070): an untrusted
     * relayer returning the hash of a different successful transaction. Persistence is
     * already skipped then, but the verdict was not reported, so a caller reading
     * `txReceipt.status` alone announced a completed transfer while nothing had entered
     * the pool.
     *
     * Undefined only when verification never ran (reverted receipt).
     */
    spentNullifiersConfirmed?: boolean;
}
