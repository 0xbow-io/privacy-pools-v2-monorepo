import type { Groth16Proof, PublicSignals } from "snarkjs";

import type { CircuitInputs, VerificationKey } from "../internal.js";

/**
 * Interface for a Groth16 prover/verifier.
 * Abstracts the proving system so that ProofService is not coupled to a specific implementation.
 */
export interface IGroth16Prover {
    /**
     * Generates a Groth16 proof from a witness and circuit artifacts.
     * @param input - Circuit witness signals.
     * @param wasm - Compiled circuit WASM binary.
     * @param provingKey - Groth16 proving key binary (zkey).
     * @returns The raw Groth16 proof and public signals.
     * @throws {Error} If the underlying proving system fails.
     */
    fullProve(
        input: CircuitInputs,
        wasm: Uint8Array,
        provingKey: Uint8Array,
    ): Promise<{ proof: Groth16Proof; publicSignals: PublicSignals }>;

    /**
     * Verifies a Groth16 proof against a verification key.
     * @param verificationKey - The Groth16 verification key.
     * @param publicSignals - The public signal values.
     * @param proof - The Groth16 proof to verify.
     * @returns True if the proof is valid.
     * @throws {Error} If the underlying verification system fails.
     */
    verify(
        verificationKey: VerificationKey,
        publicSignals: PublicSignals,
        proof: Groth16Proof,
    ): Promise<boolean>;
}
