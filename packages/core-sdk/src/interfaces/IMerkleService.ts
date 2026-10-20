import type { Hex, MerkleProof } from "../internal.js";

/**
 * Interface for the MerkleService.
 * Handles Merkle tree proof generation and verification.
 */
export interface IMerkleService {
    /**
     * Builds a Merkle tree from the given leaves and generates an inclusion proof for the specified leaf.
     * @param leaves - All leaves of the tree, in order.
     * @param leaf - The specific leaf to generate a proof for. Must exist in the leaves array.
     * @returns The Merkle inclusion proof.
     * @throws {MerkleServiceBaseError} If the leaves or leaf are invalid, the leaf is not found, or tree generation fails.
     */
    generateMerkleProof(leaves: Hex[], leaf: Hex): Promise<MerkleProof>;

    /**
     * Verifies that a Merkle proof is valid against a given root.
     * @param proof - The proof to verify.
     * @param root - The expected Merkle root to verify against.
     * @returns True if the proof is valid and matches the expected root.
     * @throws {MerkleServiceBaseError} If the proof is invalid or verification fails.
     */
    verifyMerkleProof(proof: MerkleProof, root: Hex): Promise<boolean>;

    /**
     * Pads a siblings array with zero elements up to the given tree depth.
     * @param siblings - The siblings array from a Merkle proof.
     * @param maxDepth - The maximum tree depth to pad to.
     * @returns A new array padded with "0x0" entries to reach maxDepth.
     */
    padSiblings(siblings: Hex[], maxDepth: number): Hex[];

    /**
     * Computes the LeanIMT root over the given leaves. Used to cross-check
     * off-chain leaves against an on-chain Merkle root anchor (e.g. ASP root
     * vs `ASPRegistry.latestASPRoot`).
     *
     * Empty leaves yields `"0x0"` — the LeanIMT empty-tree convention that
     * matches the on-chain sentinel for an empty Merkle root.
     *
     * @param leaves - All leaves of the tree, in order.
     * @returns The Merkle root.
     * @throws {MerkleServiceBaseError} If tree generation fails.
     */
    computeRoot(leaves: Hex[]): Promise<Hex>;
}
