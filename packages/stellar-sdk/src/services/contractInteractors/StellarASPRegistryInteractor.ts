import {
    bigintToHex,
    ContractCallError,
    ContractInteractorBaseError,
    Hash,
    IASPRegistryInteractor,
    InvalidContractResult,
    IStellarRPCInteractor,
    StellarContractInteractorConfig,
    stellarErrorMessage,
    u32ScVal,
} from "../../internal.js";

/**
 * Stellar implementation of {@link IASPRegistryInteractor}, ported from the reference Rust
 * contract's asp-registry signatures (verified directly against the
 * source, no reference client to port from — the reference implementation's
 * `AspRegistryInteractor.mjs` exists but only wraps raw `readContract` calls with no decode logic
 * of its own). Unlike EVM's single `latestASPRoot`/`latestIPFSCID` accessors, the Stellar
 * contract only exposes indexed reads (`get_root_at`/`get_cid_at`) plus `root_count`, so
 * `getLatestAssociationSetData` resolves the latest index itself before reading both.
 */
export class StellarASPRegistryInteractor implements IASPRegistryInteractor {
    private readonly rpcInteractor: IStellarRPCInteractor;
    private readonly contractId: string;
    private readonly readSourcePublicKey: string;

    constructor(config: StellarContractInteractorConfig) {
        this.rpcInteractor = config.rpcInteractor;
        this.contractId = config.contractId;
        this.readSourcePublicKey = config.readSourcePublicKey;
    }

    /**
     * @inheritdoc IASPRegistryInteractor.getLatestASPRoot
     * @throws {ContractCallError} When the RPC call fails, or no root has been submitted yet.
     */
    async getLatestASPRoot(): Promise<Hash> {
        const result = await this.simulateRead("latest_asp_root", []);
        if (typeof result !== "bigint") {
            throw new InvalidContractResult(
                `Expected U256 from latest_asp_root, got ${typeof result}`,
            );
        }
        return bigintToHex(result);
    }

    /**
     * @inheritdoc IASPRegistryInteractor.getLatestAssociationSetData
     * @throws {ContractCallError} When the RPC call fails, or no root has been submitted yet.
     */
    async getLatestAssociationSetData(): Promise<{ root: Hash; ipfsCID: string }> {
        const count = await this.simulateRead("root_count", []);
        if (typeof count !== "number" || count === 0) {
            throw new ContractCallError("No association set has been submitted yet");
        }
        const latestIndex = count - 1;

        const [root, cidBytes] = await Promise.all([
            this.simulateRead("get_root_at", [u32ScVal(latestIndex)]),
            this.simulateRead("get_cid_at", [u32ScVal(latestIndex)]),
        ]);
        if (typeof root !== "bigint") {
            throw new InvalidContractResult(`Expected U256 from get_root_at, got ${typeof root}`);
        }
        if (!(cidBytes instanceof Uint8Array)) {
            throw new InvalidContractResult(
                `Expected Bytes from get_cid_at, got ${typeof cidBytes}`,
            );
        }

        return { root: bigintToHex(root), ipfsCID: new TextDecoder().decode(cidBytes) };
    }

    private async simulateRead(method: string, args: Parameters<IStellarRPCInteractor["simulateRead"]>[2]) {
        try {
            return await this.rpcInteractor.simulateRead(
                this.contractId,
                method,
                args,
                this.readSourcePublicKey,
            );
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(stellarErrorMessage(error));
        }
    }
}
