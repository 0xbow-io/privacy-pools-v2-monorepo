import { beforeAll, describe, expect, it } from "vitest";

import type {
    Address,
    BuildDepositWitnessInputs,
    BuildRagequitWitnessInputs,
    BuildTransactWitnessInputs,
    Hash,
    Hex,
    IHashService,
    IMerkleService,
    INoteComputationService,
    MerkleProof,
    NoteData,
    NotePayload,
    PaymentRequestNotePayload,
    Secret,
} from "../../../src/internal.js";
import {
    COMMITMENT_LEAF_TAG,
    NoteStatus,
    WitnessPreparationService,
} from "../../../src/internal.js";

/**
 * Replicates the concatenation-based mock hash for pre-computing expected
 * values in tests. Result is left-padded with zeros to a full 32-byte (64
 * hex char) string so it satisfies `NoteAddressHashSchema` and other
 * 32-byte refinements used by the witness schemas.
 */
function mockHash(inputs: Hex[]): Hex {
    const concatenated = inputs.map((input) => input.slice(2)).join("");
    const truncated = concatenated.slice(-64);
    return ("0x" + truncated.padStart(64, "0")) as Hex;
}

/** Concatenation-based mock hash service for witness-internal Poseidon hashes. */
class MockHashService implements IHashService {
    hash(inputs: Hex[]): Hex {
        return mockHash(inputs);
    }
}

/** Concatenation-based mock NoteComputationService that delegates each method to mockHash. */
class MockNoteComputationService implements INoteComputationService {
    computeNoteAddressHash(ownerAddress: Address, noteSecret: Secret): Hex {
        return mockHash([ownerAddress, noteSecret]);
    }
    computePrecommitment(noteAddressHash: Hex, tokenId: Address, value: Hex): Hex {
        return mockHash([noteAddressHash, tokenId as Hex, value, "0x0" as Hex]);
    }
    computeLabel(precommitment: Hex, depositSecret: Secret): Hex {
        return mockHash([precommitment, depositSecret]);
    }
    computeFullCommitment(params: {
        noteAddressHash: Hex;
        tokenId: Address;
        value: Hex;
        label: Hex;
    }): Hex {
        const pre = this.computePrecommitment(params.noteAddressHash, params.tokenId, params.value);
        return mockHash([pre, params.label]);
    }
    computeAuthDigest(privateRevocableKey: Secret): Hex {
        return mockHash(["0x0" as Hex, privateRevocableKey]);
    }
    computeNullifier(privateNullifyingKey: Secret, commitment: Hex): Hex {
        return mockHash([privateNullifyingKey, commitment]);
    }
    computeLabelHash(label: Hex): Hex {
        return mockHash([label]);
    }
    encodeNotePayload(_payload: NotePayload): Uint8Array {
        return new Uint8Array(117);
    }
    decodeNotePayload(_bytes: Uint8Array): NotePayload {
        return {
            noteSecret: "0x0" as Secret,
            value: "0x0" as Hex,
            tokenId: "0x0" as Address,
            label: "0x0" as Hex,
        };
    }
    generateNoteData(_payload: NotePayload, _recipientViewingPubKey: Hex): NoteData {
        return { hint: "0x0" as Hex, data: "0x0" as Hex };
    }
    encodePaymentRequestNotePayload(_payload: PaymentRequestNotePayload): Uint8Array {
        return new Uint8Array(117);
    }
    decodePaymentRequestNotePayload(_bytes: Uint8Array): PaymentRequestNotePayload {
        return {
            noteAddressHash: "0x0" as Hash,
            value: "0x0" as Hex,
            tokenId: "0x0" as Address,
            label: "0x0" as Hex,
        };
    }
    generatePaymentRequestNoteData(
        _payload: PaymentRequestNotePayload,
        _recipientViewingPubKey: Hex,
    ): NoteData {
        return { hint: "0x0" as Hex, data: "0x0" as Hex };
    }
}

/** Mock that returns predictable merkle proofs. */
class MockMerkleService implements IMerkleService {
    async generateMerkleProof(leaves: Hex[], leaf: Hex): Promise<MerkleProof> {
        const index = leaves.indexOf(leaf);
        if (index === -1) throw new Error(`Leaf ${leaf} not found`);
        return {
            leaf,
            root: ("0x" + leaves[0].slice(2) + "aaa") as Hex,
            siblings: ["0xbbbb" as Hex, "0xcccc" as Hex],
            index,
        };
    }

    padSiblings(siblings: Hex[], maxDepth: number): Hex[] {
        return [
            ...siblings,
            ...Array<Hex>(Math.max(0, maxDepth - siblings.length)).fill("0x0" as Hex),
        ];
    }

    async verifyMerkleProof(): Promise<boolean> {
        return true;
    }

    async computeRoot(leaves: Hex[]): Promise<Hex> {
        if (leaves.length === 0) return "0x0" as Hex;
        return ("0x" + leaves[0].slice(2) + "aaa") as Hex;
    }
}

describe("WitnessPreparationService", () => {
    let service: WitnessPreparationService;

    beforeAll(() => {
        const noteComputationService = new MockNoteComputationService();
        const hashService = new MockHashService();
        const merkleService = new MockMerkleService();
        service = new WitnessPreparationService({
            noteComputationService,
            hashService,
            merkleService,
        });
    });

    describe("buildDepositWitness", () => {
        const validNoteAddressHash = ("0x" + "12".repeat(32)) as Hex;
        const validDepositSecret = ("0x" + "05".repeat(32)) as Secret;
        const validInputs: BuildDepositWitnessInputs = {
            noteAddressHash: validNoteAddressHash,
            tokenId: "0x3",
            value: "0x4",
            context: "0x6" as Hex,
            depositSecret: validDepositSecret,
        };

        it("return validated circuit inputs", async () => {
            const result = await service.buildDepositWitness(validInputs);

            expect(result.tokenId).toBe("0x3");
            expect(result.value).toBe("0x4");
            expect(result.context).toBe("0x6");
            expect(result.noteAddressHash).toBe(validNoteAddressHash);
            expect(result.depositSecret).toBe(validDepositSecret);
        });

        it("throw InvalidDepositWitnessInputs for invalid hex in noteAddressHash", async () => {
            const inputs = { ...validInputs, noteAddressHash: "invalid" as Hex };
            await expect(service.buildDepositWitness(inputs)).rejects.toThrow(
                "Must represent a valid hexadecimal integer value with 0x prefix",
            );
        });

        it("throw InvalidDepositWitnessInputs for missing field", async () => {
            const inputs = { ...validInputs } as Record<string, unknown>;
            delete inputs.noteAddressHash;
            await expect(
                service.buildDepositWitness(inputs as BuildDepositWitnessInputs),
            ).rejects.toThrow();
        });
    });

    describe("buildTransactWitness", () => {
        // Full-length addresses required by NoteSchema's AddressSchema validation
        const mockAddress = "0x1111111111111111111111111111111111111111";
        const mockTokenAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        // Pre-compute expected intermediate values using mockHash
        const ownerAddress: Hex = "0x1";
        const privateNullifyingKey: Secret = "0x2" as Secret;
        const privateRevocableKey: Secret = "0x3" as Secret;
        const tokenId: Hex = "0xa";

        // Authorization chain
        const authDigest = mockHash(["0x0", privateRevocableKey]); // "0x03"
        const nullKeyHash = mockHash([privateNullifyingKey]); // "0x2"
        const keystoreLeaf = mockHash([ownerAddress, nullKeyHash, authDigest]); // "0x1203"

        // Input note 1
        const noteSecret1: Secret = "0x4" as Secret;
        const noteValue1: Hex = "0x5";
        const noteLabel1: Hex = "0x6";
        const timestamp1: Hex = "0x7";

        const noteAddressHash1 = mockHash([ownerAddress, noteSecret1]); // "0x14"
        const precommitment1 = mockHash([noteAddressHash1, tokenId, noteValue1, "0x0"]); // "0x14a50"
        const commitment1 = mockHash([precommitment1, noteLabel1]); // "0x14a506"
        const timestampedLeaf1 = mockHash([COMMITMENT_LEAF_TAG, commitment1, timestamp1]); // "0x086205d9...42d914a5067"
        const labelHash1 = mockHash([noteLabel1]); // "0x6"

        // Output note 1
        const outputNoteAddressHash1: Hex = ("0x" + "8".padStart(64, "0")) as Hex;
        const outputValue1: Hex = "0x9";
        const outputLabel1: Hex = "0xb";
        const outputPrecommitment1 = mockHash([
            outputNoteAddressHash1,
            tokenId,
            outputValue1,
            "0x0",
        ]); // "0x8a90"
        const outputCommitment1 = mockHash([outputPrecommitment1, outputLabel1]); // "0x8a90b"

        const validInputs: BuildTransactWitnessInputs = {
            inputNotes: [
                {
                    noteAddressHash: noteAddressHash1,
                    commitment: commitment1,
                    noteSecret: noteSecret1,
                    value: noteValue1,
                    tokenId: mockTokenAddress,
                    label: noteLabel1,
                    status: NoteStatus.ACTIVE,
                    ownerAddress: mockAddress,
                    isOwned: true,
                    createdAtBlock: timestamp1,
                    spentAtBlock: null,
                    txHash: "0x0",
                },
            ],
            changeNotes: [
                {
                    noteAddressHash: outputNoteAddressHash1,
                    commitment: outputCommitment1 as Hash,
                    value: outputValue1,
                    tokenId: mockTokenAddress,
                    label: outputLabel1,
                    status: NoteStatus.PENDING,
                    isOwned: true as const,
                    noteSecret: "0xaa" as Secret,
                    ownerAddress: mockAddress,
                },
            ],
            recipientNotes: [],
            ownerAddress,
            privateNullifyingKey,
            privateRevocableKey,
            tokenId,
            amountOut: "0x0",
            tokenIdOut: "0x0",
            context: "0xc",
            stateLeaves: [timestampedLeaf1],
            keystoreLeaves: [keystoreLeaf],
            aspLeaves: [labelHash1],
        };

        it("include merkle proof data in witness", async () => {
            const result = await service.buildTransactWitness(validInputs);

            // Roots from mock merkle service
            expect(result.stateRoot).toBeDefined();
            expect(result.keystoreRoot).toBeDefined();
            expect(result.associationSetRoot).toBeDefined();

            // Keystore proof
            expect(result.keystoreLeafIndex).toBe("0x0");
            expect(result.keystoreSiblings).toEqual([
                "0xbbbb",
                "0xcccc",
                ...Array<string>(16).fill("0x0"),
            ]);
            expect(result.keystoreTreeDepth).toBe("0x2");

            // State proof per input
            expect(result.stateLeafIndex).toEqual(["0x0"]);
            expect(result.stateTreeDepth).toEqual(["0x2"]);

            // ASP proof per input
            expect(result.associationSetLeafIndex).toEqual(["0x0"]);
            expect(result.associationSetTreeDepth).toEqual(["0x2"]);
        });

        it("include public input signals in witness", async () => {
            const result = await service.buildTransactWitness(validInputs);

            expect(result.amountOut).toBe("0x0");
            expect(result.tokenIdOut).toBe("0x0");
            expect(result.context).toBe("0xc");
        });

        it("include authorization and per-note private signals in witness", async () => {
            const result = await service.buildTransactWitness(validInputs);

            expect(result.ownerAddress).toBe(ownerAddress);
            expect(result.privateNullifyingKey).toBe(privateNullifyingKey);
            expect(result.privateRevocableKey).toBe(privateRevocableKey);
            expect(result.tokenId).toBe(tokenId);
            expect(result.noteSecret).toEqual([noteSecret1]);
            expect(result.value).toEqual([noteValue1]);
            expect(result.label).toEqual([noteLabel1]);
            expect(result.timestamp).toEqual([timestamp1]);
        });

        it("include output note signals in witness", async () => {
            const result = await service.buildTransactWitness(validInputs);

            expect(result.outputNoteAddressHash).toEqual([outputNoteAddressHash1]);
            expect(result.outputValue).toEqual([outputValue1]);
            expect(result.outputLabel).toEqual([outputLabel1]);
        });

        it("handle multiple input and output notes", async () => {
            // Input note 2
            const noteSecret2: Secret = "0xd" as Secret;
            const noteValue2: Hex = "0xe";
            const noteLabel2: Hex = "0xf";
            const timestamp2: Hex = "0x10";

            const noteAddressHash2 = mockHash([ownerAddress, noteSecret2]);
            const precommitment2 = mockHash([noteAddressHash2, tokenId, noteValue2, "0x0"]);
            const commitment2 = mockHash([precommitment2, noteLabel2]);
            const timestampedLeaf2 = mockHash([COMMITMENT_LEAF_TAG, commitment2, timestamp2]);
            const labelHash2 = mockHash([noteLabel2]);

            // Output note 2
            const outputNoteAddressHash2: Hex = ("0x" + "11".padStart(64, "0")) as Hex;
            const outputValue2: Hex = "0x12";
            const outputLabel2: Hex = "0x13";

            const inputs: BuildTransactWitnessInputs = {
                ...validInputs,
                inputNotes: [
                    ...validInputs.inputNotes,
                    {
                        noteAddressHash: noteAddressHash2,
                        commitment: commitment2,
                        noteSecret: noteSecret2,
                        value: noteValue2,
                        tokenId: mockTokenAddress,
                        label: noteLabel2,
                        status: NoteStatus.ACTIVE,
                        ownerAddress: mockAddress,
                        isOwned: true,
                        createdAtBlock: timestamp2,
                        spentAtBlock: null,
                        txHash: "0x0",
                    },
                ],
                changeNotes: [
                    ...validInputs.changeNotes,
                    {
                        noteAddressHash: outputNoteAddressHash2,
                        commitment: "0x0" as Hash,
                        value: outputValue2,
                        tokenId: mockTokenAddress,
                        label: outputLabel2,
                        status: NoteStatus.PENDING,
                        isOwned: true as const,
                        noteSecret: "0xbb" as Secret,
                        ownerAddress: mockAddress,
                    },
                ],
                stateLeaves: [timestampedLeaf1, timestampedLeaf2],
                aspLeaves: [labelHash1, labelHash2],
            };

            const result = await service.buildTransactWitness(inputs);

            expect(result.noteSecret).toHaveLength(2);
            expect(result.outputNoteAddressHash).toHaveLength(2);
        });

        it("throw InvalidTransactWitnessInputs for empty input notes", async () => {
            const inputs = { ...validInputs, inputNotes: [] };
            await expect(service.buildTransactWitness(inputs)).rejects.toThrow(
                "At least one input note is required",
            );
        });

        it("throw InvalidTransactWitnessInputs for empty output notes", async () => {
            const inputs = { ...validInputs, changeNotes: [] };
            await expect(service.buildTransactWitness(inputs)).rejects.toThrow(
                "At least one change note is required",
            );
        });

        it("throw InvalidTransactWitnessInputs for invalid hex", async () => {
            const inputs = { ...validInputs, ownerAddress: "bad" as Hex };
            await expect(service.buildTransactWitness(inputs)).rejects.toThrow(
                "Must represent a valid hexadecimal integer value with 0x prefix",
            );
        });

        describe("pendingKeystoreRegistration (predicted post-insertion root)", () => {
            // keystoreLeaves that do NOT contain the owner's leaf — the leaf is being registered
            // in the same bundle, so it is not on-chain yet.
            const otherLeaves: Hex[] = ["0xdead", "0xbeef"];

            it("anchor to the predicted root by appending the owner's leaf when registering", async () => {
                const inputs: BuildTransactWitnessInputs = {
                    ...validInputs,
                    keystoreLeaves: otherLeaves,
                    pendingKeystoreRegistration: true,
                };

                const result = await service.buildTransactWitness(inputs);

                // The owner's leaf lands at the next index (== current tree size), proving the
                // proof was built against [...otherLeaves, ownerLeaf], not the current tree.
                expect(result.keystoreLeafIndex).toBe("0x2");
                expect(result.keystoreRoot).toBeDefined();
            });

            it("fail without the flag when the owner's leaf is not yet on-chain", async () => {
                const inputs: BuildTransactWitnessInputs = {
                    ...validInputs,
                    keystoreLeaves: otherLeaves,
                };

                // The normal path proves membership against the current tree, where the leaf is
                // absent — MerkleService cannot find it. The predicted-root path is what makes the
                // bundled registerAndRelay withdrawal provable.
                await expect(service.buildTransactWitness(inputs)).rejects.toThrow();
            });

            it("accept an empty on-chain keystore tree (first-ever registration)", async () => {
                const inputs: BuildTransactWitnessInputs = {
                    ...validInputs,
                    keystoreLeaves: [],
                    pendingKeystoreRegistration: true,
                };

                const result = await service.buildTransactWitness(inputs);

                expect(result.keystoreLeafIndex).toBe("0x0");
            });
        });
    });

    describe("buildRagequitWitness", () => {
        const mockAddress = "0x1111111111111111111111111111111111111111";
        const mockTokenAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const ownerAddress: Hex = "0x1";
        const privateNullifyingKey: Secret = "0x2" as Secret;
        const privateRevocableKey: Secret = "0x3" as Secret;
        const tokenId: Hex = "0xa";
        const label: Hex = "0x6";

        const noteSecret: Secret = "0x4" as Secret;
        const noteValue: Hex = "0x5";
        const timestamp: Hex = "0x7";

        // Pre-compute authorization
        const authDigest = mockHash(["0x0", privateRevocableKey]);
        const nullKeyHash = mockHash([privateNullifyingKey]);
        const keystoreLeaf = mockHash([ownerAddress, nullKeyHash, authDigest]);

        // Pre-compute note chain
        const noteAddressHash = mockHash([ownerAddress, noteSecret]);
        const precommitment = mockHash([noteAddressHash, tokenId, noteValue, "0x0"]);
        const expectedCommitment = mockHash([precommitment, label]);
        const expectedNullifier = mockHash([privateNullifyingKey, expectedCommitment]);

        const validInputs: BuildRagequitWitnessInputs = {
            note: {
                noteAddressHash: noteAddressHash,
                commitment: expectedCommitment,
                noteSecret,
                value: noteValue,
                tokenId: mockTokenAddress,
                label,
                status: NoteStatus.ACTIVE,
                ownerAddress: mockAddress,
                isOwned: true,
                createdAtBlock: timestamp,
                spentAtBlock: null,
                txHash: "0x0",
            },
            ownerAddress,
            privateNullifyingKey,
            privateRevocableKey,
            tokenId,
            label,
            keystoreLeaves: [keystoreLeaf],
        };

        it("compute correct nullifier and commitment", async () => {
            const result = await service.buildRagequitWitness(validInputs);

            expect(result.nullifierHash).toBe(expectedNullifier);
            expect(result.commitment).toBe(expectedCommitment);
        });

        it("include keystore merkle proof data in witness", async () => {
            const result = await service.buildRagequitWitness(validInputs);

            expect(result.witness.keystoreRoot).toBeDefined();
            expect(result.witness.keystoreLeafIndex).toBe("0x0");
            expect(result.witness.keystoreSiblings).toEqual([
                "0xbbbb",
                "0xcccc",
                ...Array<string>(16).fill("0x0"),
            ]);
            expect(result.witness.keystoreTreeDepth).toBe("0x2");
        });

        it("include public input signals in witness", async () => {
            const result = await service.buildRagequitWitness(validInputs);

            expect(result.witness.ownerAddress).toBe(ownerAddress);
            expect(result.witness.value).toBe(noteValue);
            expect(result.witness.tokenId).toBe(tokenId);
            expect(result.witness.label).toBe(label);
        });

        it("include private input signals in witness", async () => {
            const result = await service.buildRagequitWitness(validInputs);

            expect(result.witness.noteSecret).toBe(noteSecret);
            expect(result.witness.metadata).toBe("0x0");
            expect(result.witness.privateNullifyingKey).toBe(privateNullifyingKey);
            expect(result.witness.privateRevocableKey).toBe(privateRevocableKey);
        });

        it("throw InvalidRagequitWitnessInputs for invalid hex", async () => {
            const inputs = { ...validInputs, ownerAddress: "bad" as Hex };
            await expect(service.buildRagequitWitness(inputs)).rejects.toThrow(
                "Must represent a valid hexadecimal integer value with 0x prefix",
            );
        });

        it("throw InvalidRagequitWitnessInputs for empty keystore leaves", async () => {
            const inputs = { ...validInputs, keystoreLeaves: [] };
            await expect(service.buildRagequitWitness(inputs)).rejects.toThrow(
                "At least one keystore leaf is required",
            );
        });
    });
});
