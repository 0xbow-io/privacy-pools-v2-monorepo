import { decodeFunctionData, encodeFunctionData } from "viem";

import type {
    Address,
    EvmYieldRouterCodecConfig,
    Hex,
    IYieldRouterCodec,
    PreparedTransaction,
    YieldDeploymentConfig,
} from "../../internal.js";
import {
    bigintToHex,
    ENTRYPOINT_DEPOSIT_ABI,
    ERC20_APPROVE_ABI,
    planApprovals,
    POOL_VAULT_TRANSACT_ABI,
    PP_ROUTER_DEPOSIT_ABI,
    PP_ROUTER_DEPOSIT_NATIVE_ABI,
    PP_ROUTER_WITHDRAW_ABI,
    UnexpectedDepositCalldata,
    UnexpectedWithdrawCalldata,
} from "../../internal.js";

/**
 * EVM implementation of {@link IYieldRouterCodec}: lifts `(proof, noteData, aspCiphertext)` out of
 * `Entrypoint.deposit` calldata and `(proof, transactParams, noteData)` out of `PoolVault.transact`
 * calldata, and re-encodes them as `PPRouter.depositExactShares` / `PPRouter.withdrawToUnderlying`.
 * The router forwards the identical arguments to the pool, so the proof context is unchanged.
 *
 * Funding is an ERC-20 `approve(router, maxUnderlyingIn)`, preceded by `approve(router, 0)` when a
 * residual allowance exists (mainnet USDT reverts a non-zero re-approve — vuln-mining #28); none in
 * native mode (the router takes `msg.value`) or when an executor funds the deposit.
 */
export class EvmYieldRouterCodec implements IYieldRouterCodec<PreparedTransaction, Address> {
    private readonly nativeMode: boolean;
    private readonly allowanceOf?: (spender: Address) => Promise<bigint>;

    constructor(config: EvmYieldRouterCodecConfig = {}) {
        this.nativeMode = config.nativeMode ?? false;
        this.allowanceOf = config.allowanceOf;
    }

    /**
     * @inheritdoc IYieldRouterCodec.encodeDepositExactShares
     * @throws {UnexpectedDepositCalldata} When `depositTx.data` is not `Entrypoint.deposit`.
     */
    async encodeDepositExactShares(
        depositTx: PreparedTransaction,
        args: { deployment: YieldDeploymentConfig<Address>; sharesValue: bigint; maxUnderlyingIn: bigint },
    ): Promise<PreparedTransaction> {
        // An unknown selector makes viem throw, so treat any decode failure as unexpected calldata too.
        let decoded;
        try {
            decoded = decodeFunctionData({ abi: ENTRYPOINT_DEPOSIT_ABI, data: depositTx.data });
        } catch (error) {
            throw new UnexpectedDepositCalldata(
                `could not decode as Entrypoint.deposit: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        if (decoded.functionName !== "deposit" || !decoded.args) {
            throw new UnexpectedDepositCalldata(
                `expected Entrypoint.deposit, decoded ${String(decoded.functionName)}`,
            );
        }
        const [proof, noteData, aspCiphertext] = decoded.args;

        return {
            to: args.deployment.router,
            data: this.nativeMode
                ? (encodeFunctionData({
                      abi: PP_ROUTER_DEPOSIT_NATIVE_ABI,
                      functionName: "depositExactSharesNative",
                      args: [proof, noteData, aspCiphertext],
                  }) as Hex)
                : (encodeFunctionData({
                      abi: PP_ROUTER_DEPOSIT_ABI,
                      functionName: "depositExactShares",
                      args: [proof, noteData, aspCiphertext, args.maxUnderlyingIn],
                  }) as Hex),
            value: this.nativeMode ? bigintToHex(args.maxUnderlyingIn) : ("0x0" as Hex),
        };
    }

    /** @inheritdoc IYieldRouterCodec.planDepositFunding */
    async planDepositFunding(args: {
        deployment: YieldDeploymentConfig<Address>;
        maxUnderlyingIn: bigint;
        fundingSource: "wallet" | "executor";
    }): Promise<PreparedTransaction[]> {
        // The router only pulls `underlyingNeeded`, so the headroom stays approved after every
        // deposit — the next non-zero approve on USDT would revert unless reset to zero first.
        if (this.nativeMode || args.fundingSource === "executor") return [];
        const router = args.deployment.router;
        const currentAllowance = this.allowanceOf ? await this.allowanceOf(router) : 0n;
        return planApprovals(currentAllowance, args.maxUnderlyingIn, (amount) => ({
            to: args.deployment.underlying,
            data: encodeFunctionData({
                abi: ERC20_APPROVE_ABI,
                functionName: "approve",
                args: [router, amount],
            }) as Hex,
            value: "0x0" as Hex,
        }));
    }

    /**
     * @inheritdoc IYieldRouterCodec.encodeWithdrawToUnderlying
     * @throws {UnexpectedWithdrawCalldata} When `transactTx.data` is not `PoolVault.transact`.
     */
    async encodeWithdrawToUnderlying(
        transactTx: PreparedTransaction,
        args: { deployment: YieldDeploymentConfig<Address>; minUnderlyingOut: bigint; nativeGas: bigint },
    ): Promise<PreparedTransaction> {
        let decoded;
        try {
            decoded = decodeFunctionData({ abi: POOL_VAULT_TRANSACT_ABI, data: transactTx.data });
        } catch (error) {
            throw new UnexpectedWithdrawCalldata(
                `could not decode as PoolVault.transact: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        if (decoded.functionName !== "transact" || !decoded.args) {
            throw new UnexpectedWithdrawCalldata(
                `expected PoolVault.transact, decoded ${String(decoded.functionName)}`,
            );
        }
        const [proof, transactParams, noteData] = decoded.args;

        return {
            to: args.deployment.router,
            data: encodeFunctionData({
                abi: PP_ROUTER_WITHDRAW_ABI,
                functionName: "withdrawToUnderlying",
                args: [proof, transactParams, noteData, args.minUnderlyingOut],
            }) as Hex,
            value: `0x${args.nativeGas.toString(16)}` as Hex,
        };
    }
}
