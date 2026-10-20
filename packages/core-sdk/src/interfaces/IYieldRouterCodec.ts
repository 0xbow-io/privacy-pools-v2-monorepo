import type { Address, PreparedTransaction, YieldDeploymentConfig } from "../internal.js";

/**
 * The chain-specific half of the yield sessions: turning the STANDARD share-token deposit and
 * transact a chain already knows how to build into the router's calls, and planning any funding
 * step the deposit needs first.
 *
 * The core yield sessions build the standard proof (so its context is exactly what the pool
 * checks) and hand the resulting transaction here; the codec lifts the proof and its arguments
 * out and re-encodes them against the router with the extra spend cap / slippage floor. Chains
 * differ enough (ABI calldata vs Soroban XDR, ERC-20 approvals vs invocation-scoped auth) that
 * each has its own implementation.
 */
export interface IYieldRouterCodec<TTx = PreparedTransaction, TAddress = Address> {
    /**
     * Re-targets a built share-token deposit at the router's exact-shares deposit.
     *
     * @param depositTx - The standard deposit transaction for the share token.
     * @param args - The deployment, the exact shares being shielded and the spend cap to bind.
     * @returns The router deposit transaction.
     * @throws {YieldSessionBaseError} When `depositTx` is not a recognisable deposit.
     */
    encodeDepositExactShares(
        depositTx: TTx,
        args: {
            deployment: YieldDeploymentConfig<TAddress>;
            sharesValue: bigint;
            maxUnderlyingIn: bigint;
        },
    ): Promise<TTx>;
    /**
     * Plans the transactions that must land before the router deposit so it can pull the
     * underlying (EVM: ERC-20 approvals; Stellar: none — the depositor's signature on the deposit
     * itself authorizes the transfer).
     *
     * @param args - The deployment, the spend cap and who funds the deposit.
     * @returns The funding transactions in submission order (possibly empty).
     * @throws {YieldSessionBaseError | ContractInteractorBaseError}
     */
    planDepositFunding(args: {
        deployment: YieldDeploymentConfig<TAddress>;
        maxUnderlyingIn: bigint;
        fundingSource: "wallet" | "executor";
    }): Promise<TTx[]>;
    /**
     * Re-targets a built transact (processor = router, data = the encoded `PayoutRouting`) at the
     * router's withdraw-to-underlying call.
     *
     * @param transactTx - The standard transact transaction.
     * @param args - The deployment, the recipient slippage floor and any native gas to forward.
     * @returns The router withdraw transaction.
     * @throws {YieldSessionBaseError} When `transactTx` is not a recognisable transact, or the
     *   chain cannot forward `nativeGas`.
     */
    encodeWithdrawToUnderlying(
        transactTx: TTx,
        args: {
            deployment: YieldDeploymentConfig<TAddress>;
            minUnderlyingOut: bigint;
            nativeGas: bigint;
        },
    ): Promise<TTx>;
}
