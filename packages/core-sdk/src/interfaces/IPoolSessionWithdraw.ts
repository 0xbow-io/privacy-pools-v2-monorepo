import type {
    Address,
    EVMProof,
    ExecuteRegisterAndWithdrawRelayerParams,
    ExecuteWithdrawRelayerParams,
    PreparedRelayedRegistration,
    PreparedTransaction,
    PrepareRegisterAndWithdrawResult,
    PrepareWithdrawResult,
    TxLog,
    TxReceipt,
    WithdrawParams,
} from "../internal.js";

/**
 * Orchestrates transact preparation for public withdrawals. Generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, and
 * raw receipt-log type `TLog` (all default to their EVM shapes).
 */
export interface IPoolSessionWithdraw<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /**
     * Prepares a public withdrawal by building the transact witness, generating a ZK proof,
     * and encoding the calldata for on-chain submission.
     *
     * Uses the transact circuit with amountOut > 0. Creates one change output note
     * for the sender's remaining balance. The withdrawn amount exits the pool and is
     * sent to the processor address for trusted execution logic and fee management.
     *
     * @param params - The withdrawal parameters.
     * @returns The prepared withdrawal result with calldata and metadata.
     * @throws {PoolSessionTransactBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    prepareWithdraw(params: WithdrawParams<TAddress>): Promise<PrepareWithdrawResult<TTx, TAddress>>;

    /**
     * Submits a prepared withdrawal to a relayer for on-chain execution.
     *
     * @param params - The relay parameters including selected quote, proof, encrypted payload, and recipient.
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionTransactBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    relayWithdraw(params: ExecuteWithdrawRelayerParams<TAddress>): Promise<TxReceipt<TLog>>;

    /**
     * Assembles an atomic `registerAndRelay` request: builds the withdrawal proof anchored to the
     * PREDICTED post-insertion keystore root and pairs it with the signed relayed-registration
     * fields, so a fresh, unfunded recipient can register and withdraw in one relayer transaction.
     * Does NOT submit — pass the result's `relayParams` to
     * {@link IRelayerInteractor.relayRegisterAndWithdrawal}, then persist notes on confirmation.
     *
     * @param params - The selected relayer quote and withdrawal inputs.
     * @param registration - The signed relayed-registration payload from `prepareRelayedRegistration`.
     * @returns The relayer, the assembled request, and the notes to persist after confirmation.
     * @throws {PoolSessionTransactBaseError}
     */
    prepareRegisterAndWithdrawRelay(
        params: ExecuteWithdrawRelayerParams<TAddress>,
        registration: PreparedRelayedRegistration<TAddress>,
    ): Promise<PrepareRegisterAndWithdrawResult<TAddress>>;

    /**
     * Atomically registers a fresh, unfunded recipient in the keystore and withdraws their
     * note in one relayer transaction. Builds the withdrawal proof anchored to the PREDICTED
     * post-insertion keystore root, rebuilds the exact `SetAuthPolicy` typed data the caller
     * signed (bound to `params.deadline`) to recover the registration fields, and submits the
     * `register-and-withdrawal` request to the selected relayer.
     *
     * @param params - The selected relayer quote, withdrawal inputs, the `SetAuthPolicy`
     *   signature, and the deadline it was bound to.
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionTransactBaseError}
     */
    registerAndWithdraw(
        params: ExecuteRegisterAndWithdrawRelayerParams<TAddress>,
    ): Promise<TxReceipt<TLog>>;

    /**
     * Prepares and executes a public withdrawal in one step.
     *
     * @param params - The withdrawal parameters.
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionTransactBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    withdraw(params: WithdrawParams<TAddress>): Promise<TxReceipt<TLog>>;

    /**
     * Executes a previously prepared withdrawal by submitting the transaction on-chain.
     *
     * @param result - The result from prepareWithdraw.
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionTransactBaseError}
     */
    executeWithdraw(result: PrepareWithdrawResult<TTx, TAddress>): Promise<TxReceipt<TLog>>;
}
