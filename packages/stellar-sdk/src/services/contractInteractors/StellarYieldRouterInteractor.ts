import type {
    IStellarRPCInteractor,
    IYieldRouterInteractor,
    StellarAddress,
    StellarYieldRouterInteractorConfig,
    StellarYieldTokenInteractor,
    YieldQuote,
} from "../../internal.js";
import {
    addressScVal,
    ContractCallError,
    ContractInteractorBaseError,
    InvalidContractResult,
    stellarErrorMessage,
    YIELD_BPS_DENOMINATOR,
} from "../../internal.js";

/**
 * Soroban implementation of {@link IYieldRouterInteractor} over the `yield-router` contract.
 *
 * The Soroban router has no quote getters (EVM's `PPRouter.quote` / `quoteWithdraw`), so the quotes
 * are rebuilt from the same reads the router makes itself, in the same order and with the same
 * rounding — `deposit_exact_shares` mints `value + floor(value × vetting_fee_bps / 10000)` shares
 * at `preview_mint`, and `withdraw_to_underlying` redeems at `preview_redeem`.
 */
export class StellarYieldRouterInteractor implements IYieldRouterInteractor<StellarAddress> {
    private readonly rpcInteractor: IStellarRPCInteractor;
    private readonly contractId: string;
    private readonly readSourcePublicKey: string;
    private readonly poolContractId: string;
    private readonly yieldToken: StellarYieldTokenInteractor;

    constructor(config: StellarYieldRouterInteractorConfig) {
        this.rpcInteractor = config.rpcInteractor;
        this.contractId = config.contractId;
        this.readSourcePublicKey = config.readSourcePublicKey;
        this.poolContractId = config.poolContractId;
        this.yieldToken = config.yieldToken;
    }

    /** @inheritdoc IYieldRouterInteractor.getAddress */
    getAddress(): StellarAddress {
        return this.contractId;
    }

    /**
     * @inheritdoc IYieldRouterInteractor.quote
     *
     * Mirrors the router's own arithmetic, including its truncating fee division: the vetting fee
     * is read LIVE from the pool's asset config for the share token, as the router reads it.
     * @throws {InvalidContractResult} When a read returns an unexpected shape.
     * @throws {ContractCallError} When a simulation fails.
     */
    async quote(value: bigint): Promise<YieldQuote> {
        const feeBps = await this.vettingFeeBps();
        const total = value + (value * feeBps) / YIELD_BPS_DENOMINATOR;
        const underlyingNeeded = await this.yieldToken.previewMint(total);
        return { underlyingNeeded, total };
    }

    /**
     * @inheritdoc IYieldRouterInteractor.quoteWithdraw
     * @throws {InvalidContractResult} When the result is not an integer.
     * @throws {ContractCallError} When the simulation fails.
     */
    async quoteWithdraw(shares: bigint): Promise<bigint> {
        return this.yieldToken.previewRedeem(shares);
    }

    /**
     * @inheritdoc IYieldRouterInteractor.supplyBufferUnits
     *
     * Blend's `floor(b_rate) + 1`, read from the wrapper's adapter — it moves with the reserve.
     * @throws {InvalidContractResult} When a read returns an unexpected shape.
     * @throws {ContractCallError} When a simulation fails.
     */
    async supplyBufferUnits(): Promise<bigint> {
        const adapter = await this.yieldToken.adapterAddress();
        const result = await this.read(adapter, "supply_buffer", []);
        if (typeof result !== "bigint") {
            throw new InvalidContractResult(`Expected an integer from supply_buffer, got ${typeof result}`);
        }
        return result;
    }

    private async vettingFeeBps(): Promise<bigint> {
        const config = (await this.read(this.poolContractId, "get_asset_config", [
            addressScVal(this.yieldToken.getAddress()),
        ])) as { vetting_fee_bps?: unknown } | undefined;
        if (typeof config?.vetting_fee_bps !== "number") {
            throw new InvalidContractResult("Expected an AssetConfig struct for the share token from get_asset_config");
        }
        return BigInt(config.vetting_fee_bps);
    }

    private async read(
        contractId: string,
        method: string,
        args: Parameters<IStellarRPCInteractor["simulateRead"]>[2],
    ): Promise<unknown> {
        try {
            return await this.rpcInteractor.simulateRead(contractId, method, args, this.readSourcePublicKey);
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(stellarErrorMessage(error));
        }
    }
}
