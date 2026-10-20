import type {
    Address,
    Hash,
    Hex,
    ICryptoService,
    IHashService,
    IKeystoreManager,
    ILogger,
    INoteComputationService,
    IPaymentRequestStorageAdapter,
    PublicKey,
    Secret,
} from "../internal.js";

/**
 * Lifecycle status of a payment request on the recipient side.
 *
 * - `OPEN` — no genuine slot consumed yet.
 * - `FULFILLED` — at least one genuine (non-zero, still-unused) slot consumed. This is
 *   **display state only**: it never gates discovery. A request keeps being scanned
 *   while `FULFILLED`, because a genuine sender may pay a still-unused slot in a later
 *   block. The flip is driven by consumed-slot accounting, not by any single matching
 *   note — a 0-value or duplicate-slot phantom cannot advance it.
 * - `ARCHIVED` — recipient-controlled terminal state (see {@link IPaymentRequestService.archive}).
 *   Excluded from {@link IPaymentRequestService.getScannableRequests}.
 *
 * The scan set is bounded by user action (archive) or time (the `expiresAt` stamp written at
 * generation, plus a grace period) — NEVER by an attacker-craftable state flip. See finding #600.
 */
export type PaymentRequestStatus = "OPEN" | "FULFILLED" | "ARCHIVED";

/**
 * Public, shareable payment-request payload.
 *
 * Carries N pre-computed `noteAddressHash` slots so a sender can produce up to N
 * recipient notes against this request (e.g. a transfer spending across multiple
 * input commitments may emit several recipient outputs).
 *
 * Deliberately carries **only** the `noteAddressHash` values — never the matching
 * `noteSecret`. Because `noteAddressHash = Poseidon(recipientAddress, noteSecret)`,
 * shipping both would let anyone holding the request confirm a candidate EVM
 * address with a single Poseidon hash and deanonymize the recipient. The secrets
 * stay recipient-local on {@link PaymentRequestRecord}.
 *
 * Intended for QR-code / link encoding. Does not contain `paymentPrivKey` —
 * the recipient persists that locally via {@link PaymentRequestRecord}.
 */
export interface PaymentRequest {
    /** Recipient secret seed for tag derivation. Not used for encryption keys. */
    paymentId: Hex;
    /** N pre-computed `noteAddressHash` slots. Sender consumes one per recipient note created. No secrets. */
    noteAddressHashes: Hash[];
    /** Requested payment amount. Informational — not enforced on-chain. */
    amount: Hex;
    /** Requested token (asset address). */
    tokenId: Address;
    /** On-chain `hint` topic: `Poseidon([paymentId])`. Recipient queries `eth_getLogs` filtered by this. */
    tag: Hex;
    /** Public half of the per-request ephemeral X25519 keypair. Sender encrypts noteData against this. */
    paymentPubKey: PublicKey;
    /**
     * Unix-ms timestamp (hex) after which this request must not be fulfilled.
     *
     * Shared deliberately. The recipient stops scanning for a request shortly after it expires, so a payment
     * made after that point lands on-chain but is not discovered through the payment-request path.
     * Carrying the deadline in the shareable payload is what lets the SENDER see it — display it,
     * and refuse to pay a lapsed request — instead of discovering the loss after the fact.
     * `prepareFulfillPaymentRequest` enforces it.
     *
     * `undefined` means the request never expires. That is the shape of any request created before
     * expiry existed; those stay fulfillable indefinitely rather than being retroactively voided.
     */
    expiresAt?: Hex;
}

/**
 * In-memory payment-request record (recipient-side only).
 *
 * Extends {@link PaymentRequest} with lifecycle metadata and the request's
 * private key. Never serialized to QR / link / wire — strip the extra fields
 * with `toPublicPaymentRequest` before sharing. Persisted as
 * {@link StoredPaymentRequestRecord}, which omits the derivable private key.
 */
export type PaymentRequestRecord = PaymentRequest & {
    /**
     * N pre-computed `(noteAddressHash → noteSecret)` slots. Recipient-local only —
     * never shared (the public {@link PaymentRequest} carries `noteAddressHashes` alone).
     * Discovery looks the secret up here by the `noteAddressHash` decoded from the
     * v2 on-chain payload to reconstruct the spendable note.
     */
    noteSecretsMap: Map<Hash, Secret>;
    /**
     * Private half of the per-request X25519 keypair. Present on every
     * in-memory record: `PaymentRequestService` derives it on `generate` and
     * re-derives it on `loadFromStorage` via
     * {@link ICryptoService.derivePaymentRequestKeyPair}. Not part of the
     * persisted shape — see {@link StoredPaymentRequestRecord}.
     */
    paymentPrivKey: Secret;
    /** Recipient EVM address used to compute each `noteAddressHash`. Persisted so discovery can recompute commitments. */
    recipientAddress: Address;
    /** Current lifecycle state. Display-only; does NOT gate discovery. See {@link PaymentRequestStatus}. */
    status: PaymentRequestStatus;
    /** Unix-ms timestamp (hex) marking when the request was created. */
    createdAt: Hex;
    /** Commitments of recipient notes discovered against this request — an audit trail, includes phantoms (may be ≥1). */
    fulfilledByCommitments: Hex[];
    /**
     * `noteAddressHash` slots consumed by a **genuine** match (non-zero value, request-owned
     * slot, not previously consumed). Distinct from `fulfilledByCommitments`, which records
     * every discovered commitment: an attacker's 0-value or duplicate-slot phantom appears in
     * `fulfilledByCommitments` but MUST NOT appear here and MUST NOT advance fulfillment (#600).
     */
    consumedSlots: Hash[];
    /**
     * Unix-ms timestamp (hex) of the scan coverage that retired this request from the
     * discovery scan set, set by {@link IPaymentRequestService.markScanRetired}.
     *
     * `undefined` means the request is still scanned. Membership of the scan set is stamped
     * rather than recomputed from the clock so that a payment which arrived before
     * `expiresAt` stays discoverable however late the recipient scans.
     */
    scanRetiredAt?: Hex;
};

/**
 * Persisted form of {@link PaymentRequestRecord}. Drops `paymentPrivKey`: it is
 * re-derivable from the viewing key + `paymentId`, so storing it would put a
 * recoverable secret at rest for no benefit. `PaymentRequestService` hydrates
 * back to {@link PaymentRequestRecord} on load.
 */
export type StoredPaymentRequestRecord = Omit<PaymentRequestRecord, "paymentPrivKey">;

/** Atomic state blob persisted by {@link IPaymentRequestStorageAdapter}. */
export interface PaymentRequestServiceState {
    requests: StoredPaymentRequestRecord[];
}

/**
 * JSON-safe form of {@link StoredPaymentRequestRecord}, used in the account
 * export envelope. `noteSecretsMap` is an array of `[noteAddressHash, noteSecret]`
 * entries because `JSON.stringify(Map)` returns `{}`. On import the schema codec
 * accepts this shape and rebuilds the Map.
 */
export type SerializedPaymentRequestRecord = Omit<StoredPaymentRequestRecord, "noteSecretsMap"> & {
    noteSecretsMap: [Hash, Secret][];
};

/**
 * Describes a note discovered against a payment request, passed to
 * {@link IPaymentRequestService.markFulfilled}. Carries enough to decide whether the
 * match genuinely consumes a still-unused slot (see {@link PaymentRequestRecord.consumedSlots}).
 */
export interface PaymentRequestFulfillment {
    /** Commitment of the discovered recipient note. */
    commitment: Hex;
    /** The slot (`noteAddressHash`) the discovered note landed on. */
    noteAddressHash: Hash;
    /** The discovered note's value. A 0-value note never consumes a slot. */
    value: Hex;
}

/** Parameters for `generatePaymentRequest`. */
export interface GeneratePaymentRequestParams {
    /** Requested payment amount (informational). */
    amount: Hex;
    /** Requested token. */
    tokenId: Address;
    /** Number of `(noteAddressHash, noteSecret)` slots to pre-generate. Default 5. */
    slots?: number;
}

/** Parameters for `prepareFulfillPaymentRequest` / `fulfillPaymentRequest`. */
export interface FulfillPaymentRequestParams {
    /** The decoded payment request received from the recipient (e.g. via QR). */
    paymentRequest: PaymentRequest;
    /** Sender input notes to spend. `inputCommitments.length` must be ≤ `paymentRequest.noteAddressHashes.length`. */
    inputCommitments: Hash[];
    /** Optional relayer address override; defaults handled by `prepareTransfer`. */
    relayAddress?: Address;
    /** Optional fee override; defaults handled by `prepareTransfer`. */
    feeAmount?: Hex;
    /** Optional processor override; defaults handled by `prepareTransfer`. */
    processorAddress?: Address;
}

/**
 * Configuration for PaymentRequestService construction.
 *
 * Stays concretely EVM-typed by design, not yet generic over `TAddress`: {@link
 * ICryptoService.derivePaymentRequestKeyPair} HKDF-salts on the raw address bytes
 * (`hexToBytes(ownerAddress.slice(2))` in `AbstractCryptoService`), which assumes an EVM hex
 * address — the same "EVM implementation of `ICryptoService`" boundary documented on
 * `CryptoService`. A non-hex `TAddress` (e.g. Stellar's StrKey) needs `ICryptoService` itself
 * widened first; genericizing this config alone would be cosmetic.
 */
export interface PaymentRequestServiceConfig {
    /** The recipient's EVM address. Used as the `ownerAddress` in `Poseidon(ownerAddress, noteSecret)`. */
    ownerAddress: Address;
    /** Crypto service for secret generation and HKDF-derived payment-request keys. */
    cryptoService: ICryptoService;
    /** Hash service for Poseidon `tag = Poseidon([paymentId])`. */
    hashService: IHashService;
    /** Note computation service for `noteAddressHash` derivation. */
    noteComputationService: INoteComputationService;
    /** Keystore manager — supplies the viewing private key used to rehydrate `paymentPrivKey`. */
    keystoreManager: IKeystoreManager;
    /** Adapter responsible for persisting the request store. */
    storageAdapter: IPaymentRequestStorageAdapter;
    /**
     * Lifetime, in milliseconds, stamped onto each request at generation as
     * `expiresAt = createdAt + requestExpiryMs`. Bounds the scan set by time so it can never
     * grow without limit. Defaults to {@link DEFAULT_REQUEST_EXPIRY_MS} (7 days).
     *
     * Applied at generation, NOT re-evaluated against `createdAt` on each scan — so changing it
     * never re-dates an existing record, and shortening it cannot retroactively drop
     * already-shared requests out of the scan set (#600).
     *
     * Note this is the SENDER-facing deadline. The recipient keeps scanning until `expiresAt`
     * plus {@link SCAN_EXPIRY_GRACE_MS}, so a request leaves
     * {@link IPaymentRequestService.getScannableRequests} strictly later than it stops being
     * payable. Must be a positive safe integer; the constructor rejects anything else.
     */
    requestExpiryMs?: number;
}

/** Optional dependencies for PaymentRequestService. */
export interface PaymentRequestServiceDependencies {
    logger?: ILogger;
}
