import type { Hex, ISwapChainAdapter } from "../internal.js";
import { UnexpectedTransactionTarget } from "../internal.js";

/**
 * Rejects an aggregator transaction that would hand control or an allowance to the aggregator's
 * swap executor (on EVM: LiFi's `Executor`). The executor is on the router allowlist, but it runs
 * arbitrary calls for anyone, so:
 *
 * - a transaction calling it can move the funds anywhere while merely embedding the deposit
 *   bytes, which defeats every byte-containment check; and
 * - an allowance granted to it can be spent by anyone, at any time — e.g. once the swap that was
 *   meant to consume it reverts — by a `swapAndExecute` whose leg is `transferFrom(victim, …)`.
 *
 * Every flow that only vets `transactionTo` / `approvalAddress` against the allowlist runs this
 * too. The one accepted executor transaction, the session-composed same-chain native deposit, is
 * fully decoded instead and never reaches here.
 *
 * @throws {UnexpectedTransactionTarget} If the spender or target is a swap executor, or the
 *   calldata calls an executor entry point.
 */
export async function assertNoSwapExecutor<TTx, TAddress>(
    adapter: ISwapChainAdapter<TTx, TAddress>,
    tx: { transactionTo: TAddress; approvalAddress: TAddress; transactionData: Hex },
): Promise<void> {
    if (await adapter.isSwapExecutor(tx.approvalAddress)) {
        throw new UnexpectedTransactionTarget(
            `approval spender ${String(tx.approvalAddress)} is a swap executor; anyone could spend an allowance granted to it`,
        );
    }
    if (adapter.isSwapExecutorCall(tx.transactionData) || (await adapter.isSwapExecutor(tx.transactionTo))) {
        throw new UnexpectedTransactionTarget(
            `transaction to ${String(tx.transactionTo)} calls a swap executor, which runs arbitrary calls`,
        );
    }
}
