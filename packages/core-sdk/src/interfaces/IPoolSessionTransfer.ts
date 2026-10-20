import type {
    Address,
    ColdStartTransferParams,
    EVMProof,
    ExecuteTransferParams,
    FulfillPaymentRequestParams,
    GeneratePaymentRequestParams,
    PaymentRequest,
    PreparedTransaction,
    PrepareTransferResult,
    RelayTransferParams,
    TransferParams,
    TransferResult,
    TxLog,
} from "../internal.js";

/**
 * Orchestrates transact preparation for private transfers. Generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, and
 * raw receipt-log type `TLog` (all default to their EVM shapes).
 */
export interface IPoolSessionTransfer<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /**
     * Prepares a cold start transfer to a recipient identified by EVM address,
     * skipping the on-chain keystore lookup entirely.
     *
     * Generates noteSecrets internally, computes noteAddressHash for each output note,
     * and includes the secrets in the result's recipientPendingNotes. The caller MUST
     * deliver the noteSecrets to the recipient via a secure out-of-band channel.
     *
     * @param params - The cold start transfer parameters including the recipient's EVM address.
     * @returns The prepared transfer result.
     * @throws {PoolSessionTransactBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    prepareColdStartTransfer(
        params: ColdStartTransferParams<TAddress>,
    ): Promise<PrepareTransferResult<TTx, TAddress>>;

    /**
     * Prepares a private transfer by building the transact witness, generating a ZK proof,
     * and encoding the calldata for on-chain submission.
     *
     * Uses the transact circuit with amountOut = 0. Creates two output notes:
     * one for the recipient and one for the sender's change. The caller is responsible
     * for submitting the returned calldata to the PoolVault contract
     * (directly via {@link executeTransfer} or via a relayer via {@link relayTransfer}).
     *
     * When `recipientDiscoveryData.evmAddress` is provided and the recipient has not
     * registered a viewing key, the SDK falls back to out-of-band semantics — no
     * on-chain announcement is published; the sender must deliver the returned
     * noteSecrets off-chain.
     *
     * @param params - The transfer parameters.
     * @returns The prepared transfer result with executeOptions and per-relayer relayOptions.
     * @throws {PoolSessionTransactBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    prepareTransfer(params: TransferParams<TAddress>): Promise<PrepareTransferResult<TTx, TAddress>>;

    /**
     * Submits a prepared transfer to a relayer for on-chain execution.
     *
     * Honors `params.recipient.kind`: publishes encrypted noteData iff `discoverable`.
     *
     * @param params - The relay parameters including selected quote and resolved recipient.
     * @returns The transfer result containing the transaction receipt and optional recipient notes.
     * @throws {PoolSessionTransactBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    relayTransfer(params: RelayTransferParams<TAddress>): Promise<TransferResult<TAddress, TLog>>;

    /**
     * Prepares and executes a private transfer in one step.
     *
     * @param params - The transfer parameters.
     * @returns The transfer result containing the transaction receipt and optional recipient notes.
     * @throws {PoolSessionTransactBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    transfer(params: TransferParams<TAddress>): Promise<TransferResult<TAddress, TLog>>;

    /**
     * Executes a previously prepared transfer by submitting the transaction on-chain.
     *
     * @param opts - The executeOptions from {@link prepareTransfer}.
     * @returns The transfer result containing the transaction receipt and optional recipient notes.
     * @throws {PoolSessionTransactBaseError}
     */
    executeTransfer(opts: ExecuteTransferParams<TTx, TAddress>): Promise<TransferResult<TAddress, TLog>>;

    /**
     * Recipient side. Generates a fresh payment request — paymentId, ephemeral X25519
     * paymentKeyPair, recipient-chosen `tag`, and N pre-computed `(noteAddressHash, noteSecret)`
     * slots — and persists the full record (including `paymentPrivKey`) via the
     * PaymentRequestService's storage adapter.
     *
     * Returns the public, QR-shareable subset (no `paymentPrivKey`).
     *
     * @param params - amount, tokenId, optional slot count (default 5).
     * @returns The shareable payment request payload.
     * @throws {PoolSessionTransactBaseError}
     */
    generatePaymentRequest(params: GeneratePaymentRequestParams): Promise<PaymentRequest>;

    /**
     * Sender side. Prepares a transfer that fulfills the supplied payment request.
     *
     * Reuses the existing {@link prepareTransfer} flow — constructs the discoverable
     * `RecipientDiscoveryData` variant from the request and forwards it. The returned
     * `PrepareTransferResult` is runnable as-is by {@link relayTransfer} or
     * {@link executeTransfer}.
     *
     * @param params - The decoded payment request, input commitments, and optional relayer overrides.
     * @returns The prepared transfer result.
     * @throws {PoolSessionTransactBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    prepareFulfillPaymentRequest(
        params: FulfillPaymentRequestParams,
    ): Promise<PrepareTransferResult<TTx, TAddress>>;
}
