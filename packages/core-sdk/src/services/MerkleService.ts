import { LeanIMT } from "@zk-kit/lean-imt";

import type {
    Hex,
    IHashService,
    ILogger,
    IMerkleService,
    MerkleProof,
    MerkleServiceConfig,
    MerkleServiceDependencies,
} from "../internal.js";
import {
    HexSchema,
    InvalidLeaf,
    InvalidLeaves,
    InvalidMerkleProof,
    LeafNotFound,
    LeavesSchema,
    MerkleProofSchema,
    MerkleProofVerificationFailed,
    TreeGenerationError,
} from "../internal.js";

/**
 * Implementation of the MerkleService interface.
 * Uses LeanIMT from @zk-kit/lean-imt for tree operations and IHashService for hashing.
 */
export class MerkleService implements IMerkleService {
    private readonly hashService: IHashService;
    private readonly logger?: ILogger;

    /**
     * Creates a new MerkleService instance.
     * @param config - The configuration for the MerkleService.
     * @param config.hashService - The hash service to use.
     * @param dependencies - Optional dependencies for the MerkleService.
     * @param dependencies.logger - The logger to use.
     */
    constructor(config: MerkleServiceConfig, dependencies?: MerkleServiceDependencies) {
        this.hashService = config.hashService;
        this.logger = dependencies?.logger;
    }

    /**
     * @inheritdoc IMerkleService.generateMerkleProof
     * @throws {InvalidLeaves} If the leaves array fails schema validation.
     * @throws {InvalidLeaf} If the leaf fails schema validation.
     * @throws {LeafNotFound} If the leaf is not present in the tree.
     * @throws {TreeGenerationError} If tree construction fails.
     */
    async generateMerkleProof(leaves: Hex[], leaf: Hex): Promise<MerkleProof> {
        const validatedLeaves = LeavesSchema.safeParse(leaves);
        if (!validatedLeaves.success) {
            throw new InvalidLeaves(validatedLeaves.error.issues[0].message);
        }

        const validatedLeaf = HexSchema.safeParse(leaf);
        if (!validatedLeaf.success) {
            throw new InvalidLeaf(validatedLeaf.error.issues[0].message);
        }

        const tree = this.generateTree(validatedLeaves.data);

        const leafIndex = tree.indexOf(validatedLeaf.data);
        if (leafIndex === -1) {
            throw new LeafNotFound(`Leaf ${validatedLeaf.data} not found in tree`);
        }
        this.logger?.debug("Leaf index found", { leafIndex });

        const proof = tree.generateProof(leafIndex);

        this.logger?.debug("Merkle proof generated successfully", { proof });

        return proof;
    }

    /**
     * @inheritdoc IMerkleService.padSiblings
     */
    padSiblings(siblings: Hex[], maxDepth: number): Hex[] {
        return [
            ...siblings,
            ...Array<Hex>(Math.max(0, maxDepth - siblings.length)).fill("0x0" as Hex),
        ];
    }

    /**
     * @inheritdoc IMerkleService.computeRoot
     * @throws {InvalidLeaves} If the leaves array fails schema validation.
     * @throws {TreeGenerationError} If tree construction fails.
     */
    async computeRoot(leaves: Hex[]): Promise<Hex> {
        // LeanIMT has no defined root for an empty tree — the on-chain
        // `latestASPRoot` is `0x0` for an empty ASP, so we adopt the same
        // convention here. Skips a needless tree construction too.
        if (leaves.length === 0) return "0x0" as Hex;

        const validatedLeaves = LeavesSchema.safeParse(leaves);
        if (!validatedLeaves.success) {
            throw new InvalidLeaves(validatedLeaves.error.issues[0].message);
        }

        const tree = this.generateTree(validatedLeaves.data);
        return tree.root as Hex;
    }

    /**
     * @inheritdoc IMerkleService.verifyMerkleProof
     * @throws {InvalidMerkleProof} If the proof fails schema validation.
     * @throws {MerkleProofVerificationFailed} If the underlying verification throws.
     */
    async verifyMerkleProof(proof: MerkleProof): Promise<boolean> {
        const validatedProof = MerkleProofSchema.safeParse(proof);
        if (!validatedProof.success) {
            throw new InvalidMerkleProof(validatedProof.error.issues[0].message);
        }

        try {
            this.logger?.debug("Verifying proof...", { proof });
            const verified = LeanIMT.verifyProof(proof, this.hashFn.bind(this));

            this.logger?.debug("Proof verified successfully", { verified });
            return verified;
        } catch (error) {
            this.logger?.error("Error verifying proof", { error });
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new MerkleProofVerificationFailed(errorMessage || "Unknown error");
        }
    }

    /**
     * Hashes two hex values using the hash service.
     * @param a - The first hex value.
     * @param b - The second hex value.
     * @returns The hash of the two hex values.
     */
    private hashFn(a: Hex, b: Hex): Hex {
        return this.hashService.hash([a, b]);
    }

    /**
     * Generates a LeanIMT tree from the given leaves.
     * @param leaves - The leaves to generate the tree from.
     * @returns The generated tree.
     */
    private generateTree(leaves: Hex[]): LeanIMT<Hex> {
        try {
            const tree = new LeanIMT<Hex>(this.hashFn.bind(this));

            this.logger?.debug("Generating tree...", { leaves });

            tree.insertMany(leaves);

            this.logger?.debug("Tree generated successfully", { tree });
            return tree;
        } catch (error) {
            this.logger?.error("Error generating tree", { error });
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new TreeGenerationError(errorMessage || "Unknown error");
        }
    }
}
