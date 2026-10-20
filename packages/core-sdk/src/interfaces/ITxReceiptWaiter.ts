import type { Hex, TxLog, TxReceipt } from "../internal.js";

/**
 * The one RPC capability the session orchestrators actually need: waiting for a submitted
 * transaction to confirm and reading back its receipt. Generic over the chain's raw log type
 * `TLog` (defaults to EVM's {@link TxLog}).
 *
 * Split out from {@link IRPCInteractor} deliberately — every orchestrator (`PoolSessionDeposit`,
 * `PoolSessionRagequit`, `TransactOrchestrator`, `PoolSessionTransfer`, `PoolSessionWithdraw`,
 * `PoolSessionKeystore`, `PoolSessionBatchWithdraw`) only ever calls
 * `waitForTransactionReceipt` on its injected RPC dependency, never `readContract`/
 * `getLogsPaginated`/etc. Requiring the full `IRPCInteractor` there would force a future Stellar
 * RPC interactor to also implement EVM-only methods (ABI-shaped reads, block-range log
 * pagination) it has no use for, just to satisfy the type. `IRPCInteractor` extends this
 * interface, so no EVM call site changes: `ViemRPCInteractor` already satisfies it.
 */
export interface ITxReceiptWaiter<TLog = TxLog> {
    /**
     * Waits for a transaction to be confirmed on-chain and returns its receipt.
     * @param hash - The transaction hash (0x-prefixed, 32 bytes).
     * @returns The transaction receipt.
     * @throws {RPCInteractorBaseError}
     */
    waitForTransactionReceipt(hash: Hex): Promise<TxReceipt<TLog>>;
}
