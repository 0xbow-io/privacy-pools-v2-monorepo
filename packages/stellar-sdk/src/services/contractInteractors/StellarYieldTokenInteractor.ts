import type {
    IStellarRPCInteractor,
    IYieldTokenInteractor,
    StellarAddress,
    StellarContractInteractorConfig,
} from "../../internal.js";
import {
    ContractCallError,
    ContractInteractorBaseError,
    i128ScVal,
    InvalidContractResult,
    stellarErrorMessage,
} from "../../internal.js";

/**
 * Soroban implementation of {@link IYieldTokenInteractor} over the `yield-token` contract — the
 * non-rebasing share wrapper over a Blend position. Read-only: every call is a simulation.
 *
 * Adds the two reads the Stellar router quote needs and the EVM wrapper does not expose through
 * this interface: `previewMint` (the exact-output cost, venue supply buffer included) and
 * `adapterAddress` (where the buffer's `b_rate` is read from).
 */
export class StellarYieldTokenInteractor implements IYieldTokenInteractor<StellarAddress> {
    private readonly rpcInteractor: IStellarRPCInteractor;
    private readonly contractId: string;
    private readonly readSourcePublicKey: string;

    constructor(config: StellarContractInteractorConfig) {
        this.rpcInteractor = config.rpcInteractor;
        this.contractId = config.contractId;
        this.readSourcePublicKey = config.readSourcePublicKey;
    }

    /** @inheritdoc IYieldTokenInteractor.getAddress */
    getAddress(): StellarAddress {
        return this.contractId;
    }

    /**
     * @inheritdoc IYieldTokenInteractor.exchangeRate
     * @throws {InvalidContractResult} When the result is not an integer.
     * @throws {ContractCallError} When the simulation fails.
     */
    async exchangeRate(): Promise<bigint> {
        return this.readBigInt("exchange_rate", []);
    }

    /**
     * @inheritdoc IYieldTokenInteractor.previewDeposit
     * @throws {InvalidContractResult} When the result is not an integer.
     * @throws {ContractCallError} When the simulation fails.
     */
    async previewDeposit(assets: bigint): Promise<bigint> {
        return this.readBigInt("preview_deposit", [i128ScVal(assets)]);
    }

    /**
     * @inheritdoc IYieldTokenInteractor.previewRedeem
     * @throws {InvalidContractResult} When the result is not an integer.
     * @throws {ContractCallError} When the simulation fails.
     */
    async previewRedeem(shares: bigint): Promise<bigint> {
        return this.readBigInt("preview_redeem", [i128ScVal(shares)]);
    }

    /**
     * Underlying an exact-output mint of `shares` costs: `to_assets(shares, Up)` plus the venue's
     * supply buffer — exactly what the router charges for its exact-shares deposit.
     *
     * @param shares - Shares to mint, raw integer.
     * @returns The underlying cost, raw integer.
     * @throws {InvalidContractResult} When the result is not an integer.
     * @throws {ContractCallError} When the simulation fails.
     */
    async previewMint(shares: bigint): Promise<bigint> {
        return this.readBigInt("preview_mint", [i128ScVal(shares)]);
    }

    /**
     * The lending adapter the wrapper supplies through.
     *
     * @returns The adapter contract address.
     * @throws {InvalidContractResult} When the result is not an address.
     * @throws {ContractCallError} When the simulation fails.
     */
    async adapterAddress(): Promise<StellarAddress> {
        const result = await this.read("adapter_address", []);
        if (typeof result !== "string") {
            throw new InvalidContractResult(`Expected an address from adapter_address, got ${typeof result}`);
        }
        return result;
    }

    private async readBigInt(method: string, args: Parameters<IStellarRPCInteractor["simulateRead"]>[2]): Promise<bigint> {
        const result = await this.read(method, args);
        if (typeof result !== "bigint") {
            throw new InvalidContractResult(`Expected an integer from ${method}, got ${typeof result}`);
        }
        return result;
    }

    private async read(method: string, args: Parameters<IStellarRPCInteractor["simulateRead"]>[2]): Promise<unknown> {
        try {
            return await this.rpcInteractor.simulateRead(this.contractId, method, args, this.readSourcePublicKey);
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(stellarErrorMessage(error));
        }
    }
}
