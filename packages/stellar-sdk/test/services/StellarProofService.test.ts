import { describe, expect, it } from "vitest";

import type { Hex, ProofResult } from "../../src/internal.js";
import { StellarProofService } from "../../src/internal.js";

function hexOf(decimal: string): Hex {
    return `0x${BigInt(decimal).toString(16)}` as Hex;
}

// Ground truth computed directly against the reference implementation's own sdk/src/convert.mjs
// convertProof()/convertSignals() for these exact inputs.
const FAKE_PROOF_RESULT: ProofResult = {
    proof: {
        pi_a: [hexOf("12345678901234567890"), hexOf("98765432109876543210")],
        pi_b: [
            [hexOf("111111111111"), hexOf("222222222222")],
            [hexOf("333333333333"), hexOf("444444444444")],
        ],
        pi_c: [hexOf("555555555555"), hexOf("666666666666")],
        protocol: "groth16",
        curve: "bn128",
    },
    publicSignals: [hexOf("777777777777"), hexOf("888888888888"), hexOf("0")],
};

const EXPECTED_A =
    "0x000000000000000000000000000000000000000000000000ab54a98ceb1f0ad20000000000000000000000000000000000000000000000055aa54d38e5267eea";
const EXPECTED_B =
    "0x00000000000000000000000000000000000000000000000000000033bd7a038e00000000000000000000000000000000000000000000000000000019debd01c7000000000000000000000000000000000000000000000000000000677af4071c0000000000000000000000000000000000000000000000000000004d9c370555";
const EXPECTED_C =
    "0x0000000000000000000000000000000000000000000000000000008159b108e30000000000000000000000000000000000000000000000000000009b386e0aaa";

describe("StellarProofService", () => {
    const service = new StellarProofService({
        circuitArtifacts: {} as never,
        groth16Prover: {} as never,
    });

    describe("formatForChain", () => {
        it("pack G1 point A into 64 bytes (x BE ‖ y BE), matching the reference implementation's convertProof", () => {
            const result = service.formatForChain(FAKE_PROOF_RESULT);
            expect(result.a).toBe(EXPECTED_A);
            expect(result.a.length).toBe(2 + 64 * 2);
        });

        it("pack G2 point B into 128 bytes with imaginary component first, matching the reference implementation", () => {
            const result = service.formatForChain(FAKE_PROOF_RESULT);
            expect(result.b).toBe(EXPECTED_B);
            expect(result.b.length).toBe(2 + 128 * 2);
        });

        it("pack G1 point C into 64 bytes, matching the reference implementation's convertProof", () => {
            const result = service.formatForChain(FAKE_PROOF_RESULT);
            expect(result.c).toBe(EXPECTED_C);
            expect(result.c.length).toBe(2 + 64 * 2);
        });

        it("convert public signals to bigint in circuit output order", () => {
            const result = service.formatForChain(FAKE_PROOF_RESULT);
            expect(result.pubSignals).toEqual([777777777777n, 888888888888n, 0n]);
        });
    });
});
