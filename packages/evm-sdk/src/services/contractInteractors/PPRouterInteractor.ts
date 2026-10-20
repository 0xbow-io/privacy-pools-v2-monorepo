import type {
    Address,
    ContractInteractorConfig,
    ContractInteractorReadDependencies,
    ILogger,
    IPPRouterInteractor,
    IRPCInteractor,
    YieldQuote,
} from "../../internal.js";
import {
    BigIntSchema,
    ContractCallError,
    ContractInteractorBaseError,
    ContractInteractorConfigSchema,
    InvalidContractResult,
    InvalidInteractorAddress,
    PP_ROUTER_ABI,
    ZAP_SUPPLY_BUFFER_UNITS,
} from "../../internal.js";

/** Viem-backed implementation of {@link IPPRouterInteractor} (read-only sizing quotes). */
export class PPRouterInteractor implements IPPRouterInteractor {
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

    /** @inheritdoc IPPRouterInteractor.getAddress */
    getAddress(): Address {
        return this.contractAddress;
    }

    /**
     * @inheritdoc IPPRouterInteractor.quote
     * @throws {InvalidContractResult} When the result is not a (uint256, uint256) tuple.
     * @throws {ContractCallError} When the RPC call fails.
     */
    async quote(value: bigint): Promise<YieldQuote> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: PP_ROUTER_ABI,
                functionName: "quote",
                args: [value],
            });

            // A two-output view returns a positional tuple [underlyingNeeded, total].
            if (!Array.isArray(result) || result.length < 2) {
                throw new InvalidContractResult("quote did not return a (uint256, uint256) tuple");
            }
            const underlyingNeeded = BigIntSchema.safeParse(result[0]);
            const total = BigIntSchema.safeParse(result[1]);
            if (!underlyingNeeded.success) {
                throw new InvalidContractResult(underlyingNeeded.error.issues[0].message);
            }
            if (!total.success) {
                throw new InvalidContractResult(total.error.issues[0].message);
            }

            return { underlyingNeeded: underlyingNeeded.data, total: total.data };
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) {
                throw error;
            }

            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * @inheritdoc IPPRouterInteractor.quoteWithdraw
     * @throws {InvalidContractResult} When the result is not a bigint.
     * @throws {ContractCallError} When the RPC call fails.
     */
    async quoteWithdraw(shares: bigint): Promise<bigint> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: PP_ROUTER_ABI,
                functionName: "quoteWithdraw",
                args: [shares],
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

    /**
     * @inheritdoc IYieldRouterInteractor.supplyBufferUnits
     *
     * The zap's `_SUPPLY_ROUNDING_BUFFER` is a contract constant, so this makes no request.
     */
    async supplyBufferUnits(): Promise<bigint> {
        return ZAP_SUPPLY_BUFFER_UNITS;
    }
}
