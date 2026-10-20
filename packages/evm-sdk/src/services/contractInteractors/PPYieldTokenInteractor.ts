import { encodeFunctionData } from "viem";

import type {
    Address,
    ContractInteractorConfig,
    ContractInteractorReadDependencies,
    Hex,
    ILogger,
    IPPYieldTokenInteractor,
    IRPCInteractor,
    PreparedTransaction,
} from "../../internal.js";
import {
    BigIntSchema,
    ContractCallError,
    ContractInteractorBaseError,
    ContractInteractorConfigSchema,
    InvalidContractResult,
    InvalidInteractorAddress,
    InvalidYieldAddress,
    PP_YIELD_TOKEN_ABI,
    PP_YIELD_TOKEN_REDEEM_ABI,
} from "../../internal.js";

/** Viem-backed implementation of {@link IPPYieldTokenInteractor} (read-only ERC-4626 views). */
export class PPYieldTokenInteractor implements IPPYieldTokenInteractor {
    private readonly rpcInteractor: IRPCInteractor;
    private readonly contractAddress: Address;
    private readonly logger?: ILogger;

    /**
     * @throws {InvalidInteractorAddress} When the contract address is invalid.
     */
    constructor(config: ContractInteractorConfig, deps?: ContractInteractorReadDependencies) {
        const validated = ContractInteractorConfigSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidInteractorAddress(validated.error.issues[0].message);
        }

        this.rpcInteractor = config.rpcInteractor;
        this.contractAddress = config.contractAddress;
        this.logger = deps?.logger;
    }

    /** @inheritdoc IPPYieldTokenInteractor.getAddress */
    getAddress(): Address {
        return this.contractAddress;
    }

    /**
     * @inheritdoc IPPYieldTokenInteractor.exchangeRate
     * @throws {InvalidContractResult} When the result is not a bigint.
     * @throws {ContractCallError} When the RPC call fails.
     */
    async exchangeRate(): Promise<bigint> {
        return this.readUint("exchangeRate", []);
    }

    /**
     * @inheritdoc IPPYieldTokenInteractor.previewDeposit
     * @throws {InvalidContractResult} When the result is not a bigint.
     * @throws {ContractCallError} When the RPC call fails.
     */
    async previewDeposit(assets: bigint): Promise<bigint> {
        return this.readUint("previewDeposit", [assets]);
    }

    /**
     * @inheritdoc IPPYieldTokenInteractor.previewRedeem
     * @throws {InvalidContractResult} When the result is not a bigint.
     * @throws {ContractCallError} When the RPC call fails.
     */
    async previewRedeem(shares: bigint): Promise<bigint> {
        return this.readUint("previewRedeem", [shares]);
    }

    /**
     * @inheritdoc IPPYieldTokenInteractor.encodeRedeem
     * @throws {InvalidYieldAddress} When `receiver` or `owner` is the zero address (a zero receiver
     *   would burn the redeemed aToken).
     */
    encodeRedeem(shares: bigint, receiver: Address, owner: Address): PreparedTransaction {
        if (BigInt(receiver) === 0n) {
            throw new InvalidYieldAddress(
                "redeem receiver is the zero address (would burn assets)",
            );
        }
        if (BigInt(owner) === 0n) {
            throw new InvalidYieldAddress("redeem owner is the zero address");
        }
        return {
            to: this.contractAddress,
            data: encodeFunctionData({
                abi: PP_YIELD_TOKEN_REDEEM_ABI,
                functionName: "redeem",
                args: [shares, receiver, owner],
            }) as Hex,
            value: "0x0" as Hex,
        };
    }

    /**
     * Reads a single-uint256 view function and validates the result.
     *
     * @throws {InvalidContractResult} When the result is not a bigint.
     * @throws {ContractCallError} When the RPC call fails.
     */
    private async readUint(
        functionName: "exchangeRate" | "previewDeposit" | "previewRedeem",
        args: readonly bigint[],
    ): Promise<bigint> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: PP_YIELD_TOKEN_ABI,
                functionName,
                args,
            });
            const safeResult = BigIntSchema.safeParse(result);
            if (!safeResult.success) {
                throw new InvalidContractResult(safeResult.error.issues[0].message);
            }

            return safeResult.data;
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) {
                throw error;
            }

            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }
}
