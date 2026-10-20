import { Groth16Proof } from "snarkjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    CircuitInputs,
    Hex,
    ICircuitArtifacts,
    IGroth16Prover,
    Proof,
} from "../../../src/internal.js";
import {
    CircuitArtifactLoadFailed,
    InvalidProof,
    InvalidTransactDimensions,
    InvalidWitness,
    ProofGenerationFailed,
    ProofService,
    ProofVerificationFailed,
} from "../../../src/internal.js";

const mockFullProve = vi.fn();
const mockVerify = vi.fn();
const mockGroth16Prover: IGroth16Prover = {
    fullProve: mockFullProve,
    verify: mockVerify,
};

const MOCK_GROTH16_PROOF: Groth16Proof = {
    pi_a: ["1", "2", "3"],
    pi_b: [
        ["4", "5"],
        ["6", "7"],
        ["8", "9"],
    ],
    pi_c: ["10", "11", "12"],
    protocol: "groth16",
    curve: "bn128",
};
const MOCK_PROOF: Proof = {
    pi_a: ["0x1", "0x2", "0x3"],
    pi_b: [
        ["0x4", "0x5"],
        ["0x6", "0x7"],
        ["0x8", "0x9"],
    ],
    pi_c: ["0xa", "0xb", "0xc"],
    protocol: "groth16",
    curve: "bn128",
};
const MOCK_GROTH16_PUBLIC_SIGNALS = ["100", "200", "300"];
const MOCK_PUBLIC_SIGNALS = ["0x64", "0xc8", "0x12c"];

const MOCK_WASM = new Uint8Array([1, 2, 3]);
const MOCK_PROVING_KEY = new Uint8Array([4, 5, 6]);
const MOCK_VKEY = {
    protocol: "groth16",
    curve: "bn128",
    nPublic: 3,
    vk_alpha_1: ["1", "2", "1"],
    vk_beta_2: [
        ["3", "4"],
        ["5", "6"],
        ["1", "0"],
    ],
    vk_gamma_2: [
        ["7", "8"],
        ["9", "10"],
        ["1", "0"],
    ],
    vk_delta_2: [
        ["11", "12"],
        ["13", "14"],
        ["1", "0"],
    ],
    IC: [
        ["15", "16", "1"],
        ["17", "18", "1"],
    ],
};
const MOCK_VKEY_BYTES = new TextEncoder().encode(JSON.stringify(MOCK_VKEY));

class MockCircuitArtifacts implements ICircuitArtifacts {
    getWasm = vi.fn();
    getProvingKey = vi.fn();
    getVerificationKey = vi.fn();
}

describe("ProofService", () => {
    let proofService: ProofService;
    let mockArtifacts: MockCircuitArtifacts;
    const validWitness: CircuitInputs = { a: "0x1", b: "0x2" };

    beforeEach(() => {
        vi.clearAllMocks();

        mockArtifacts = new MockCircuitArtifacts();
        mockArtifacts.getWasm.mockResolvedValue(MOCK_WASM);
        mockArtifacts.getProvingKey.mockResolvedValue(MOCK_PROVING_KEY);
        mockArtifacts.getVerificationKey.mockResolvedValue(MOCK_VKEY_BYTES);

        mockFullProve.mockResolvedValue({
            proof: MOCK_GROTH16_PROOF,
            publicSignals: MOCK_GROTH16_PUBLIC_SIGNALS,
        });
        mockVerify.mockResolvedValue(true);

        proofService = new ProofService({
            circuitArtifacts: mockArtifacts,
            groth16Prover: mockGroth16Prover,
        });
    });

    describe("input validation", () => {
        it("throw InvalidWitness for an empty witness", async () => {
            await expect(proofService.proveDeposit({})).rejects.toThrow(InvalidWitness);
        });

        it("throw InvalidTransactDimensions for nInputs out of range", async () => {
            await expect(proofService.proveTransact(validWitness, 0, 3)).rejects.toThrow(
                InvalidTransactDimensions,
            );
            await expect(proofService.proveTransact(validWitness, 6, 3)).rejects.toThrow(
                InvalidTransactDimensions,
            );
        });

        it("throw InvalidTransactDimensions for mOutputs out of range", async () => {
            await expect(proofService.proveTransact(validWitness, 3, 0)).rejects.toThrow(
                InvalidTransactDimensions,
            );
            await expect(proofService.proveTransact(validWitness, 3, 6)).rejects.toThrow(
                InvalidTransactDimensions,
            );
        });

        it("throw InvalidTransactDimensions for non-integer dimensions", async () => {
            await expect(proofService.proveTransact(validWitness, 1.5, 2)).rejects.toThrow(
                InvalidTransactDimensions,
            );
        });

        it("throw InvalidProof for a malformed proof structure", async () => {
            const badProof = {
                proof: { pi_a: [] } as unknown as Proof,
                publicSignals: ["0x1"] as Hex[],
            };
            await expect(proofService.verifyDeposit(badProof)).rejects.toThrow(InvalidProof);
        });
    });

    describe("proveDeposit", () => {
        it("call snarkjs fullProve with the deposit circuit", async () => {
            const result = await proofService.proveDeposit(validWitness);

            expect(mockFullProve).toHaveBeenCalledWith(validWitness, MOCK_WASM, MOCK_PROVING_KEY);
            expect(mockArtifacts.getWasm).toHaveBeenCalledWith("deposit");
            expect(mockArtifacts.getProvingKey).toHaveBeenCalledWith("deposit");
            expect(result.proof).toEqual(MOCK_PROOF);
        });

        it("convert publicSignals to Hex[]", async () => {
            const result = await proofService.proveDeposit(validWitness);

            expect(result.publicSignals).toEqual(MOCK_PUBLIC_SIGNALS);
            expect(result.publicSignals.every((s) => typeof s === "string")).toBe(true);
        });
    });

    describe("proveTransact", () => {
        it("format the correct circuit name for transact variants", async () => {
            await proofService.proveTransact(validWitness, 2, 3);
            expect(mockArtifacts.getWasm).toHaveBeenCalledWith("transact_2x3");
        });

        it("work for all valid dimension combinations", async () => {
            for (let n = 1; n <= 5; n++) {
                for (let m = 1; m <= 5; m++) {
                    vi.clearAllMocks();
                    mockArtifacts.getWasm.mockResolvedValue(MOCK_WASM);
                    mockArtifacts.getProvingKey.mockResolvedValue(MOCK_PROVING_KEY);
                    mockFullProve.mockResolvedValue({
                        proof: MOCK_GROTH16_PROOF,
                        publicSignals: MOCK_GROTH16_PUBLIC_SIGNALS,
                    });

                    const result = await proofService.proveTransact(validWitness, n, m);
                    expect(mockArtifacts.getWasm).toHaveBeenCalledWith(`transact_${n}x${m}`);
                    expect(result.proof).toEqual(MOCK_PROOF);
                }
            }
        });
    });

    describe("proveRagequit", () => {
        it("call snarkjs fullProve with the ragequit circuit", async () => {
            const result = await proofService.proveRagequit(validWitness);

            expect(mockArtifacts.getWasm).toHaveBeenCalledWith("ragequit");
            expect(result.proof).toEqual(MOCK_PROOF);
            expect(result.publicSignals).toEqual(MOCK_PUBLIC_SIGNALS);
        });
    });

    describe("verifyDeposit", () => {
        it("call snarkjs verify with the deposit circuit", async () => {
            const proofResult = {
                proof: MOCK_PROOF,
                publicSignals: MOCK_PUBLIC_SIGNALS as Hex[],
            };
            const result = await proofService.verifyDeposit(proofResult);

            expect(result).toBe(true);
            expect(mockVerify).toHaveBeenCalledWith(
                MOCK_VKEY,
                ["100", "200", "300"],
                expect.anything(),
            );
            expect(mockArtifacts.getVerificationKey).toHaveBeenCalledWith("deposit");
        });

        it("return false when snarkjs verify returns false", async () => {
            mockVerify.mockResolvedValue(false);
            const proofResult = { proof: MOCK_PROOF, publicSignals: ["0x64"] as Hex[] };
            const result = await proofService.verifyDeposit(proofResult);
            expect(result).toBe(false);
        });
    });

    describe("verifyTransact", () => {
        it("validate dimensions and call snarkjs verify with the correct circuit", async () => {
            const proofResult = { proof: MOCK_PROOF, publicSignals: ["0x64"] as Hex[] };
            await proofService.verifyTransact(proofResult, 3, 4);

            expect(mockArtifacts.getVerificationKey).toHaveBeenCalledWith("transact_3x4");
        });

        it("throw InvalidTransactDimensions for invalid dimensions", async () => {
            const proofResult = { proof: MOCK_PROOF, publicSignals: ["0x64"] as Hex[] };
            await expect(proofService.verifyTransact(proofResult, 0, 1)).rejects.toThrow(
                InvalidTransactDimensions,
            );
        });
    });

    describe("verifyRagequit", () => {
        it("call snarkjs verify with the ragequit circuit", async () => {
            const proofResult = { proof: MOCK_PROOF, publicSignals: ["0x64"] as Hex[] };
            await proofService.verifyRagequit(proofResult);

            expect(mockArtifacts.getVerificationKey).toHaveBeenCalledWith("ragequit");
        });
    });

    describe("loadCircuit", () => {
        it("pre-load and cache circuit artifacts", async () => {
            await proofService.loadCircuit("deposit");

            expect(mockArtifacts.getWasm).toHaveBeenCalledWith("deposit");
            expect(mockArtifacts.getProvingKey).toHaveBeenCalledWith("deposit");
        });

        it("not re-load artifacts on subsequent prove calls", async () => {
            await proofService.loadCircuit("deposit");
            vi.clearAllMocks();

            mockFullProve.mockResolvedValue({
                proof: MOCK_GROTH16_PROOF,
                publicSignals: MOCK_GROTH16_PUBLIC_SIGNALS,
            });

            await proofService.proveDeposit(validWitness);

            expect(mockArtifacts.getWasm).not.toHaveBeenCalled();
            expect(mockArtifacts.getProvingKey).not.toHaveBeenCalled();
        });
    });

    describe("artifact caching", () => {
        it("only call getWasm and getProvingKey once per circuit", async () => {
            await proofService.proveDeposit(validWitness);
            await proofService.proveDeposit(validWitness);

            expect(mockArtifacts.getWasm).toHaveBeenCalledTimes(1);
            expect(mockArtifacts.getProvingKey).toHaveBeenCalledTimes(1);
        });

        it("only call getVerificationKey once per circuit", async () => {
            const proofResult = { proof: MOCK_PROOF, publicSignals: ["0x64"] as Hex[] };
            await proofService.verifyDeposit(proofResult);
            await proofService.verifyDeposit(proofResult);

            expect(mockArtifacts.getVerificationKey).toHaveBeenCalledTimes(1);
        });

        it("cache artifacts separately per circuit name", async () => {
            await proofService.proveDeposit(validWitness);
            await proofService.proveRagequit(validWitness);

            expect(mockArtifacts.getWasm).toHaveBeenCalledTimes(2);
            expect(mockArtifacts.getWasm).toHaveBeenCalledWith("deposit");
            expect(mockArtifacts.getWasm).toHaveBeenCalledWith("ragequit");
        });
    });

    describe("error handling", () => {
        it("throw CircuitArtifactLoadFailed when artifact loading fails", async () => {
            mockArtifacts.getWasm.mockRejectedValue(new Error("File not found"));

            await expect(proofService.proveDeposit(validWitness)).rejects.toThrow(
                CircuitArtifactLoadFailed,
            );
        });

        it("throw ProofGenerationFailed when snarkjs fullProve fails", async () => {
            mockFullProve.mockRejectedValue(new Error("Proving failed"));

            await expect(proofService.proveDeposit(validWitness)).rejects.toThrow(
                ProofGenerationFailed,
            );
        });

        it("throw ProofVerificationFailed when snarkjs verify throws", async () => {
            mockVerify.mockRejectedValue(new Error("Verification error"));

            const proofResult = { proof: MOCK_PROOF, publicSignals: ["0x64"] as Hex[] };
            await expect(proofService.verifyDeposit(proofResult)).rejects.toThrow(
                ProofVerificationFailed,
            );
        });

        it("throw CircuitArtifactLoadFailed when verification key loading fails", async () => {
            mockArtifacts.getVerificationKey.mockRejectedValue(new Error("VKey not found"));

            const proofResult = { proof: MOCK_PROOF, publicSignals: ["0x64"] as Hex[] };
            await expect(proofService.verifyDeposit(proofResult)).rejects.toThrow(
                CircuitArtifactLoadFailed,
            );
        });
    });
});
