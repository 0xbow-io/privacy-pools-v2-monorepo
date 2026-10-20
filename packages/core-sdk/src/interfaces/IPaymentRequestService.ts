import type {
    GeneratePaymentRequestParams,
    Hex,
    PaymentRequestFulfillment,
    PaymentRequestRecord,
    PaymentRequestStatus,
    SerializedPaymentRequestRecord,
} from "../internal.js";

/**
 * Recipient-side service that generates, persists, and tracks payment requests.
 *
 * Each request bundles N `(noteAddressHash, noteSecret)` slots, an ephemeral X25519
 * keypair, and a recipient-chosen `tag`. The full record (including `paymentPrivKey`)
 * is persisted via {@link IPaymentRequestStorageAdapter}; only the public-shareable
 * subset is returned to integrators.
 */
export interface IPaymentRequestService {
    /**
     * Generates a fresh payment request, persists it, and returns the full record.
     * Callers wanting the QR-shareable shape should derive it via `toPublicPaymentRequest`.
     *
     * @param params - Request parameters (amount, tokenId, optional slots).
     * @returns The persisted request record.
     * @throws {PaymentRequestBaseError}
     */
    generate(params: GeneratePaymentRequestParams): Promise<PaymentRequestRecord>;

    /**
     * Returns all stored payment requests, optionally filtered by status.
     * @param filter - Optional status filter.
     * @throws {PaymentRequestBaseError}
     */
    list(filter?: { status?: PaymentRequestStatus }): Promise<PaymentRequestRecord[]>;

    /**
     * Returns all OPEN payment requests. Equivalent to `list({ status: "OPEN" })`.
     * A display/UX convenience — NOT the discovery scan set (see {@link getScannableRequests}).
     * @throws {PaymentRequestBaseError}
     */
    getOpenRequests(): Promise<PaymentRequestRecord[]>;

    /**
     * Returns the requests note discovery must scan: every live request regardless of
     * OPEN/FULFILLED display status, excluding only recipient-archived requests and
     * requests already retired by {@link markScanRetired}. Decouples the scan set from
     * fulfillment status so a phantom "fulfilled" flip can never suppress a genuine later
     * payment note (#600), and from wall-clock time so a payment that arrived before the
     * deadline stays discoverable to a recipient who scans after it.
     * @throws {PaymentRequestBaseError}
     */
    getScannableRequests(): Promise<PaymentRequestRecord[]>;

    /**
     * Retires every request whose deadline is at or below `coveredThroughMs` from the scan
     * set, recording the coverage that retired it.
     *
     * `coveredThroughMs` is a timestamp the chain has been SCANNED THROUGH, not the current
     * time. That is the whole distinction: a payment made before the deadline is on-chain
     * and matchable forever, so the clock passing proves nothing about whether it was seen,
     * while a pass that covered the deadline does. Passing `Date.now()` here reintroduces
     * exactly the wall-clock retirement this replaces.
     *
     * Callers that cannot state a covered-through timestamp should not call this: the scan
     * set then stays bounded by {@link archive} alone.
     *
     * Idempotent — a request already retired keeps its original coverage stamp.
     *
     * @param coveredThroughMs - Unix-ms timestamp (hex) the scan is known to have covered.
     * @throws {PaymentRequestBaseError}
     */
    markScanRetired(coveredThroughMs: Hex): Promise<void>;

    /**
     * Records a discovered note against the request identified by `paymentId`.
     * Always appends the commitment to `fulfilledByCommitments` (audit trail). Advances
     * fulfillment (records a consumed slot and, from OPEN, flips display status to
     * FULFILLED) only when the match is genuine — a non-zero-value note on a request-owned,
     * still-unused slot. A 0-value or duplicate-slot phantom is recorded but never advances
     * fulfillment. Idempotent — repeated calls with the same commitment are skipped.
     *
     * @param paymentId - The request's paymentId.
     * @param fulfillment - The discovered note's commitment, slot, and value.
     * @throws {PaymentRequestBaseError}
     */
    markFulfilled(paymentId: Hex, fulfillment: PaymentRequestFulfillment): Promise<void>;

    /**
     * Moves a request to the recipient-controlled terminal `ARCHIVED` state, removing it
     * from the discovery scan set ({@link getScannableRequests}). This is the ONLY
     * user-driven terminal transition; it cannot be triggered by an on-chain event.
     * Idempotent — archiving an already-archived request is a no-op.
     *
     * @param paymentId - The request's paymentId.
     * @throws {PaymentRequestBaseError}
     */
    archive(paymentId: Hex): Promise<void>;

    /**
     * Removes all persisted payment requests.
     * @throws {PaymentRequestBaseError}
     */
    clear(): Promise<void>;

    /**
     * Loads previously persisted state from the storage adapter into memory.
     * Must be called once before serving requests when persistence is desired.
     * @throws {PaymentRequestBaseError}
     */
    loadFromStorage(): Promise<void>;

    /**
     * Returns a JSON-safe snapshot of all stored requests for the account export
     * envelope. The re-derivable `paymentPrivKey` is dropped; `noteSecretsMap`
     * is carried as array-of-entries.
     * @returns The serialized request records.
     * @throws {PaymentRequestBaseError}
     */
    exportState(): SerializedPaymentRequestRecord[];

    /**
     * Replaces all in-memory requests with the supplied snapshot and persists it.
     * Used by account import to restore pending requests onto a fresh session.
     * @param records - Snapshot previously produced by `exportState`.
     * @throws {PaymentRequestBaseError}
     */
    importState(records: SerializedPaymentRequestRecord[]): Promise<void>;
}
