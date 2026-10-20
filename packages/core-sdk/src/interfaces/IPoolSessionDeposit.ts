import type {
    Address,
    DepositForParams,
    DepositParams,
    EVMProof,
    PrepareDepositResult,
    PreparedTransaction,
    TxLog,
    TxReceipt,
} from "../internal.js";

/**
 * Orchestrates deposit preparation: witness building, proof generation, and calldata encoding.
 * Generic over the chain's prepared-transaction type `TTx`, address type `TAddress`, on-chain
 * proof type `TProof`, and raw receipt-log type `TLog` (all default to their EVM shapes).
 */
export interface IPoolSessionDeposit<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /**
     * Prepares a deposit by building the witness, generating a ZK proof,
     * and encoding the calldata for on-chain submission.
     *
     * For ERC-20 deposits, checks the current allowance and returns the
     * `approvalTxs` to submit first (one; two on a token that requires a zero
     * reset before re-approving a residual allowance, e.g. mainnet USDT).
     * `approvalTx` mirrors the last one. For native ETH deposits both are empty/null.
     *
     * @param params - The deposit parameters (token and amount).
     * @returns The prepared deposit result with calldata and optional approval tx.
     * @throws {PoolSessionDepositBaseError}
     */
    prepareDeposit(params: DepositParams<TAddress>): Promise<PrepareDepositResult<TTx, TAddress>>;

    /**
     * Prepares a deposit on behalf of a recipient.
     *
     * Accepts one of three forms:
     * - Pre-computed `noteAddressHash` only — blind cold-start, no note announcement.
     * - `discoveryData` with `evmAddress` — SDK fetches the recipient's viewing key,
     *   generates a noteSecret when absent, and computes the noteAddressHash. An
     *   unregistered recipient throws by default; pass `allowOutOfBandFallback: true`
     *   to opt into the result carrying `noteSecret` instead (no on-chain
     *   announcement — caller must deliver it to the recipient themselves).
     * - `discoveryData` with `publicViewingKey` — caller supplies the viewing key,
     *   noteAddressHash, and noteSecret directly.
     *
     * @param params - The deposit-for parameters.
     * @returns The prepared deposit result with calldata, optional approval tx, and
     *   `noteSecret` when the out-of-band fallback fired.
     * @throws {PoolSessionDepositBaseError}
     */
    prepareDepositFor(
        params: DepositForParams<TAddress>,
    ): Promise<PrepareDepositResult<TTx, TAddress>>;

    /**
     * Prepares and executes a deposit in one step.
     *
     * @param params - The deposit parameters (token and amount).
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionDepositBaseError}
     */
    deposit(params: DepositParams<TAddress>): Promise<TxReceipt<TLog>>;

    /**
     * Executes a previously prepared deposit by submitting the transaction on-chain.
     *
     * @param result - The result from prepareDeposit or prepareDepositFor.
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionDepositBaseError}
     */
    executeDeposit(result: PrepareDepositResult<TTx, TAddress>): Promise<TxReceipt<TLog>>;

    /**
     * Prepares and executes a deposit-for in one step.
     *
     * Rejects `discoveryData.allowOutOfBandFallback` — this one-shot method returns only
     * a `TxReceipt`, with no channel to hand back a recovered `noteSecret` if the fallback
     * fires. Use `prepareDepositFor` + `executeDeposit` instead for that case.
     *
     * @param params - The deposit-for parameters (see {@link prepareDepositFor} for accepted forms).
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionDepositBaseError}
     */
    depositFor(params: DepositForParams<TAddress>): Promise<TxReceipt<TLog>>;
}
