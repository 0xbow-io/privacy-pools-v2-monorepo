import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { DepositCircuitInputs, Hex, Secret } from "../../src/internal.js";
import {
    CryptoService,
    Groth16Prover,
    LocalCircuitArtifacts,
    MerkleService,
    NoteComputationService,
    PoseidonHashService,
    ProofService,
    WitnessPreparationService,
} from "../../src/internal.js";

/**
 * Integration tests for the proof pipeline:
 *   WitnessPreparationService → ProofService → Groth16Prover → snarkjs
 *
 * Requires compiled circuit artifacts under packages/circuits/build/.
 * To build them: `pnpm --filter @privacy-pools-v2/circuits build`
 */

const CIRCUITS_BUILD_DIR = resolve(__dirname, "../../../../packages/circuits/build");
const DEPOSIT_WASM = resolve(CIRCUITS_BUILD_DIR, "deposit/deposit_js/deposit.wasm");

const hasDepositArtifacts = existsSync(DEPOSIT_WASM);

describe.skipIf(!hasDepositArtifacts)("ProofService integration (real artifacts)", () => {
    let hashService: PoseidonHashService;
    let merkleService: MerkleService;
    let noteComputationService: NoteComputationService;
    let witnessService: WitnessPreparationService;
    let proofService: ProofService;

    beforeAll(async () => {
        hashService = await PoseidonHashService.create();
        merkleService = new MerkleService({ hashService });
        const cryptoService = new CryptoService();
        noteComputationService = new NoteComputationService({ hashService, cryptoService });
        witnessService = new WitnessPreparationService({
            noteComputationService,
            hashService,
            merkleService,
        });

        const circuitArtifacts = new LocalCircuitArtifacts({ baseDir: CIRCUITS_BUILD_DIR });
        const groth16Prover = new Groth16Prover();
        proofService = new ProofService({ circuitArtifacts, groth16Prover });
    });

    describe("deposit", () => {
        const ownerAddress = "0x742d35cc6634c0532925a3b844bc9e7fe0c0f392" as Hex;
        const tokenId = "0x1" as Hex;
        const value = "0x64" as Hex;
        const context = "0xaaaaaaaaaaaaaaaa" as Hex;
        const noteSecret =
            "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" as Secret;
        const depositSecret =
            "0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba" as Secret;

        let depositWitness: DepositCircuitInputs;

        beforeAll(async () => {
            const noteAddressHash = noteComputationService.computeNoteAddressHash(
                ownerAddress,
                noteSecret,
            );
            depositWitness = await witnessService.buildDepositWitness({
                noteAddressHash,
                tokenId,
                value,
                context,
                depositSecret,
            });
        });

        it("build a valid deposit witness", () => {
            expect(depositWitness.tokenId).toBe(tokenId);
            expect(depositWitness.value).toBe(value);
            expect(depositWitness.noteAddressHash).toMatch(/^0x[0-9a-f]+$/);
            expect(depositWitness.depositSecret).toBe(depositSecret);
        });

        it("generate a valid deposit proof", { timeout: 30_000 }, async () => {
            const proof = await proofService.proveDeposit(depositWitness);

            expect(proof.proof).toBeDefined();
            expect(proof.proof.protocol).toBe("groth16");
            expect(proof.proof.curve).toBe("bn128");
            expect(proof.proof.pi_a).toHaveLength(3);
            expect(proof.proof.pi_b).toHaveLength(3);
            expect(proof.proof.pi_c).toHaveLength(3);
            expect(proof.publicSignals.length).toBeGreaterThan(0);
            expect(proof.publicSignals.every((s) => s.startsWith("0x"))).toBe(true);
        });

        it("verify a generated deposit proof", { timeout: 30_000 }, async () => {
            const proof = await proofService.proveDeposit(depositWitness);
            const isValid = await proofService.verifyDeposit(proof);

            expect(isValid).toBe(true);
        });

        it("reject a tampered deposit proof", { timeout: 30_000 }, async () => {
            const proof = await proofService.proveDeposit(depositWitness);
            const tamperedProof = {
                ...proof,
                publicSignals: proof.publicSignals.map(() => "0xdeadbeef" as Hex),
            };

            const isValid = await proofService.verifyDeposit(tamperedProof);

            expect(isValid).toBe(false);
        });

        it("produce different proofs for different inputs", { timeout: 60_000 }, async () => {
            const noteAddressHash = noteComputationService.computeNoteAddressHash(
                ownerAddress,
                noteSecret,
            );
            const witness2 = await witnessService.buildDepositWitness({
                noteAddressHash,
                tokenId,
                value: "0xc8" as Hex,
                context,
                depositSecret,
            });

            expect(witness2.value).not.toBe(depositWitness.value);

            const proof1 = await proofService.proveDeposit(depositWitness);
            const proof2 = await proofService.proveDeposit(witness2);

            expect(proof1.publicSignals).not.toEqual(proof2.publicSignals);
        });
    });
});
