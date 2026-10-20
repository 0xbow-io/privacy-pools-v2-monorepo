import type {
    Address,
    PreparedTransaction,
    PrepareSwapAndDepositResult,
    SwapAndDepositParams,
    TxReceipt,
} from "../internal.js";

/**
 * Orchestrates swap-and-deposit: swap token X to token Y, then deposit Y into the pool
 * atomically. Generic over the chain's prepared-transaction type `TTx` and address type
 * `TAddress`.
 */
export interface IPoolSessionSwapDeposit<TTx = PreparedTransaction, TAddress = Address> {
    /**
     * Prepares a swap-and-deposit by generating the deposit proof for the target token,
     * then obtaining a contract-calls quote from the swap-and-deposit provider that
     * atomically swaps and deposits.
     *
     * @param params - The swap-and-deposit parameters (input token, deposit token, amount).
     * @returns The prepared result with transaction calldata and pending note.
     * @throws {PoolSessionSwapDepositBaseError}
     */
    prepareSwapAndDeposit(
        params: SwapAndDepositParams<TAddress>,
    ): Promise<PrepareSwapAndDepositResult<TTx, TAddress>>;

    /**
     * Executes a previously prepared swap-and-deposit by submitting the transaction.
     *
     * @param result - The result from prepareSwapAndDeposit.
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionSwapDepositBaseError}
     */
    executeSwapAndDeposit(result: PrepareSwapAndDepositResult<TTx, TAddress>): Promise<TxReceipt>;

    /**
     * Prepares and executes a swap-and-deposit in one step.
     *
     * @param params - The swap-and-deposit parameters.
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionSwapDepositBaseError}
     */
    swapAndDeposit(params: SwapAndDepositParams<TAddress>): Promise<TxReceipt>;
}
