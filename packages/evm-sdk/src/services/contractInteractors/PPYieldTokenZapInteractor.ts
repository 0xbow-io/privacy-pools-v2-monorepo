import { encodeFunctionData } from "viem";

import type {
    Address,
    ContractInteractorConfig,
    ContractInteractorReadDependencies,
    Hex,
    ILogger,
    IPPYieldTokenZapInteractor,
    PreparedTransaction,
} from "../../internal.js";
import {
    ContractInteractorConfigSchema,
    InvalidInteractorAddress,
    InvalidYieldAddress,
    PP_YIELD_TOKEN_ZAP_REDEEM_ABI,
} from "../../internal.js";

/** Viem-backed implementation of {@link IPPYieldTokenZapInteractor} (calldata encoding). */
export class PPYieldTokenZapInteractor implements IPPYieldTokenZapInteractor {
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

        this.contractAddress = config.contractAddress;
        this.logger = deps?.logger;
    }

    /** @inheritdoc IPPYieldTokenZapInteractor.getAddress */
    getAddress(): Address {
        return this.contractAddress;
    }

    /**
     * @inheritdoc IPPYieldTokenZapInteractor.encodeRedeemToUnderlying
     * @throws {InvalidYieldAddress} When `receiver` is the zero address (a zero receiver would burn the
     *   redeemed underlying).
     */
    encodeRedeemToUnderlying(shares: bigint, receiver: Address): PreparedTransaction {
        if (BigInt(receiver) === 0n) {
            throw new InvalidYieldAddress(
                "redeemToUnderlying receiver is the zero address (would burn assets)",
            );
        }
        return {
            to: this.contractAddress,
            data: encodeFunctionData({
                abi: PP_YIELD_TOKEN_ZAP_REDEEM_ABI,
                functionName: "redeemToUnderlying",
                args: [shares, receiver],
            }) as Hex,
            value: "0x0" as Hex,
        };
    }
}
