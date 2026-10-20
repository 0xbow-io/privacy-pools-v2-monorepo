import type { Hash } from "../internal.js";

/** Read-only interactions with the ASPRegistry contract. */
export interface IASPRegistryInteractor {
    /**
     * Reads the latest ASP root from the registry.
     *
     * @returns The current association set root.
     * @throws {ContractInteractorBaseError}
     */
    getLatestASPRoot(): Promise<Hash>;

    /**
     * Reads the latest association set data (root + IPFS CID) from the registry.
     *
     * @returns The root hash and IPFS CID of the latest association set.
     * @throws {ContractInteractorBaseError}
     */
    getLatestAssociationSetData(): Promise<{ root: Hash; ipfsCID: string }>;
}
