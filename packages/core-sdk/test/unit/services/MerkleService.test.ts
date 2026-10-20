import { beforeAll, describe, expect, it } from "vitest";

import type { Hex } from "../../../src/types/Hex.js";
import type { MerkleProof } from "../../../src/types/MerkleService.js";
import { IHashService } from "../../../src/interfaces/IHashService.js";
import { MerkleService } from "../../../src/services/MerkleService.js";

class MockHashService implements IHashService {
    hash(inputs: Hex[]): Hex {
        return ("0x" + inputs.map((input) => input.slice(2)).join("")) as Hex;
    }
}

describe("MerkleService", () => {
    let merkleService: MerkleService;

    beforeAll(async () => {
        const hashService = new MockHashService();
        merkleService = new MerkleService({
            hashService,
        });
    });

    describe("generateMerkleProof", () => {
        it("throw InvalidLeaves error when leaves array is empty", async () => {
            const leaves: Hex[] = [];
            await expect(merkleService.generateMerkleProof(leaves, "0x1")).rejects.toThrow(
                "At least one leaf is required",
            );
        });

        it("throw InvalidLeaves error when leaves contain invalid hex values", async () => {
            const leaves = ["0x1", "0x2", "invalid"] as Hex[];
            await expect(merkleService.generateMerkleProof(leaves, "0x1")).rejects.toThrow(
                "Must represent a valid hexadecimal integer value with 0x prefix",
            );
        });

        it("throw InvalidLeaf error when leaf is not a valid hex value", async () => {
            const leaves: Hex[] = ["0x1", "0x2", "0x3"];
            await expect(
                merkleService.generateMerkleProof(leaves, "invalid" as Hex),
            ).rejects.toThrow("Must represent a valid hexadecimal integer value with 0x prefix");
        });

        it("throw InvalidLeaf error when leaf is missing 0x prefix", async () => {
            const leaves: Hex[] = ["0x1", "0x2", "0x3"];
            await expect(merkleService.generateMerkleProof(leaves, "abc" as Hex)).rejects.toThrow(
                "Must represent a valid hexadecimal integer value with 0x prefix",
            );
        });

        it("accept valid hex values with different cases", async () => {
            const leaves: Hex[] = ["0xABC", "0xdef", "0x123"];
            const proof = await merkleService.generateMerkleProof(leaves, "0xABC");

            expect(proof.leaf).toBe("0xABC");
            expect(proof.root).toBeDefined();
        });

        it("generate a valid proof for each leaf in a 4-leaf tree", async () => {
            const leaves: Hex[] = ["0x1", "0x2", "0x3", "0x4"];

            for (const leaf of leaves) {
                const proof = await merkleService.generateMerkleProof(leaves, leaf);

                expect(proof.leaf).toBe(leaf);
                expect(proof.root).toBeDefined();
                expect(proof.root).toBe("0x1234");
            }
        });

        it("produce the same root for all leaves in the same tree", async () => {
            const leaves: Hex[] = ["0x1", "0x2", "0x3", "0x4"];
            const proofs = await Promise.all(
                leaves.map((leaf) => merkleService.generateMerkleProof(leaves, leaf)),
            );

            const root = proofs[0].root;
            for (const proof of proofs) {
                expect(proof.root).toBe(root);
            }
        });

        it("throw if leaf is not in the tree", async () => {
            const leaves: Hex[] = ["0x1", "0x2", "0x3"];
            await expect(merkleService.generateMerkleProof(leaves, "0xdead")).rejects.toThrow(
                "Leaf 0xdead not found in tree",
            );
        });

        it("handle a single-leaf tree", async () => {
            const leaves: Hex[] = ["0xabc"];
            const proof = await merkleService.generateMerkleProof(leaves, "0xabc");

            expect(proof.leaf).toBe("0xabc");
            // Single leaf tree: the leaf IS the root
            expect(proof.root).toBe("0xabc");
        });

        it("handle an odd number of leaves", async () => {
            const leaves: Hex[] = ["0x1", "0x2", "0x3"];
            const proof = await merkleService.generateMerkleProof(leaves, "0x3");

            expect(proof.leaf).toBe("0x3");
        });
    });

    describe("verifyMerkleProof", () => {
        it("throw InvalidMerkleProof error when proof is missing required fields", async () => {
            const proof = {
                leaf: "0x1",
                root: "0x1",
                siblings: ["0x2", "0x3"],
                // index: 1, // Missing index
            } as unknown as MerkleProof;
            await expect(merkleService.verifyMerkleProof(proof)).rejects.toThrow(
                "Invalid input: expected number, received undefined",
            );
        });

        it("throw InvalidMerkleProof error when proof has invalid hex values", async () => {
            const proof: MerkleProof = {
                leaf: "0x1",
                root: "0xG",
                siblings: ["0x2", "0x3"],
                index: 0,
            };
            await expect(merkleService.verifyMerkleProof(proof)).rejects.toThrow(
                "Must represent a valid hexadecimal integer value with 0x prefix",
            );
        });

        it("reject a proof with more siblings than the deepest supported tree", async () => {
            // 23 > STATE_MAX_DEPTH (22): an oversized siblings array from a hostile source must
            // not reach the LeanIMT build.
            const proof: MerkleProof = {
                leaf: "0x1",
                root: "0x1",
                siblings: Array.from({ length: 23 }, () => "0x2" as Hex),
                index: 0,
            };
            await expect(merkleService.verifyMerkleProof(proof)).rejects.toThrow(
                "A proof has at most 22 siblings",
            );
        });

        it("verify a valid proof", async () => {
            const leaves: Hex[] = ["0x1", "0x2", "0x3", "0x4"];
            const proof = await merkleService.generateMerkleProof(leaves, "0x2");

            const isValid = await merkleService.verifyMerkleProof(proof);
            expect(isValid).toBe(true);
        });

        it("verify proofs for all leaves in a tree", async () => {
            const leaves: Hex[] = ["0x1", "0x2", "0x3", "0x4"];

            for (const leaf of leaves) {
                const proof = await merkleService.generateMerkleProof(leaves, leaf);

                const isValid = await merkleService.verifyMerkleProof(proof);
                expect(isValid).toBe(true);
            }
        });

        it("reject a proof with a wrong root", async () => {
            const leaves: Hex[] = ["0x1", "0x2", "0x3", "0x4"];
            const proof = await merkleService.generateMerkleProof(leaves, "0x1");
            proof.root = "0xdead";

            const isValid = await merkleService.verifyMerkleProof(proof);
            expect(isValid).toBe(false);
        });

        it("reject a proof with a tampered sibling", async () => {
            const leaves: Hex[] = ["0x1", "0x2", "0x3", "0x4"];
            const proof = await merkleService.generateMerkleProof(leaves, "0x1");

            const tamperedProof: MerkleProof = {
                ...proof,
                siblings: ["0xbad", ...proof.siblings.slice(1)],
            };

            const isValid = await merkleService.verifyMerkleProof(tamperedProof);
            expect(isValid).toBe(false);
        });

        it("reject a proof with a tampered leaf", async () => {
            const leaves: Hex[] = ["0x1", "0x2", "0x3", "0x4"];
            const proof = await merkleService.generateMerkleProof(leaves, "0x1");

            const tamperedProof: MerkleProof = {
                ...proof,
                leaf: "0xbad",
            };

            const isValid = await merkleService.verifyMerkleProof(tamperedProof);
            expect(isValid).toBe(false);
        });
    });

    // The predicted-post-insertion root the relayed-registration withdrawal proof anchors to:
    // append the new leaf to the current tree and prove membership against the resulting root.
    describe("predicted post-insertion root", () => {
        const currentLeaves: Hex[] = ["0x1", "0x2", "0x3"];
        const newLeaf: Hex = "0x4";

        it("compute a different root after appending the new leaf", async () => {
            const currentRoot = await merkleService.computeRoot(currentLeaves);
            const predictedRoot = await merkleService.computeRoot([...currentLeaves, newLeaf]);

            expect(predictedRoot).not.toBe(currentRoot);
        });

        it("place the new leaf at the next index with a proof root equal to the predicted root", async () => {
            const predictedLeaves = [...currentLeaves, newLeaf];
            const predictedRoot = await merkleService.computeRoot(predictedLeaves);
            const proof = await merkleService.generateMerkleProof(predictedLeaves, newLeaf);

            expect(proof.index).toBe(currentLeaves.length);
            expect(proof.root).toBe(predictedRoot);
            expect(await merkleService.verifyMerkleProof(proof)).toBe(true);
        });
    });
});
