import type {
    Address,
    ContractInteractorConfig,
    Hash,
    IASPRegistryInteractor,
    IRPCInteractor,
} from "../../internal.js";
import {
    ASP_REGISTRY_ABI,
    bigintToHex,
    ContractCallError,
    ContractInteractorConfigSchema,
    HexSchema,
    InvalidInteractorAddress,
} from "../../internal.js";

/** Viem-backed implementation of {@link IASPRegistryInteractor}. */
export class ASPRegistryInteractor implements IASPRegistryInteractor {
    private readonly rpcInteractor: IRPCInteractor;
    private readonly contractAddress: Address;

    /**
     * @throws {InvalidInteractorAddress} When the contract address is invalid.
     */
    constructor(config: ContractInteractorConfig) {
        const validated = ContractInteractorConfigSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidInteractorAddress(validated.error.issues[0].message);
        }

        this.rpcInteractor = config.rpcInteractor;
        this.contractAddress = config.contractAddress;
    }

    /**
     * @inheritdoc IASPRegistryInteractor.getLatestASPRoot
     * @throws {ContractCallError} When the RPC call fails.
     */
    async getLatestASPRoot(): Promise<Hash> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: ASP_REGISTRY_ABI,
                functionName: "latestASPRoot",
            });
            if (typeof result !== "bigint") {
                throw new ContractCallError(
                    `latestASPRoot returned ${typeof result}, expected bigint`,
                );
            }
            return bigintToHex(result);
        } catch (error) {
            if (error instanceof ContractCallError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * @inheritdoc IASPRegistryInteractor.getLatestAssociationSetData
     * @throws {ContractCallError} When the RPC call fails.
     */
    async getLatestAssociationSetData(): Promise<{ root: Hash; ipfsCID: string }> {
        try {
            const root = await this.getLatestASPRoot();
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: ASP_REGISTRY_ABI,
                functionName: "latestIPFSCID",
            });
            const cidValidation = HexSchema.safeParse(result);
            if (!cidValidation.success) {
                throw new ContractCallError(
                    `latestIPFSCID returned non-hex: ${cidValidation.error.issues[0].message}`,
                );
            }
            const cidHex = cidValidation.data.slice(2);
            const cidByteGroups = cidHex.match(/.{1,2}/g);
            if (!cidByteGroups) {
                throw new ContractCallError("latestIPFSCID returned empty bytes");
            }
            const ipfsCID = new TextDecoder().decode(
                Uint8Array.from(cidByteGroups.map((byte) => parseInt(byte, 16))),
            );
            return { root, ipfsCID };
        } catch (error) {
            if (error instanceof ContractCallError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }
}
