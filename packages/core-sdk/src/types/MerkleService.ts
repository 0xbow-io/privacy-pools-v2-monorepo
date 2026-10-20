import type { Hex, IHashService, ILogger } from "../internal.js";

/**
 * A Merkle inclusion proof for a leaf in a binary Merkle tree.
 */
export interface MerkleProof {
    /** The leaf value being proven. */
    leaf: Hex;
    /** The computed Merkle root. */
    root: Hex;
    /** Sibling hashes along the path from leaf to root, padded to maxDepth. */
    siblings: Hex[];
    /** The index of the leaf in the tree. */
    index: number;
}

/**
 * Configuration for the MerkleService.
 */
export interface MerkleServiceConfig {
    /** The hash service used to compute tree nodes. */
    hashService: IHashService;
}

/**
 * Dependencies for the MerkleService.
 */
export interface MerkleServiceDependencies {
    logger?: ILogger;
}
