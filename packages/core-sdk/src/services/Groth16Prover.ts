import type { Groth16Proof, PublicSignals } from "snarkjs";
import { groth16 } from "snarkjs";

import type { CircuitInputs, IGroth16Prover, VerificationKey } from "../internal.js";

/**
 * Default Groth16 prover/verifier implementation backed by snarkjs.
 * TODO: Implement a custom Prover which supports ServiceWorker.
 */
export class Groth16Prover implements IGroth16Prover {
    /** @inheritdoc IGroth16Prover.fullProve */
    async fullProve(
        input: CircuitInputs,
        wasm: Uint8Array,
        provingKey: Uint8Array,
    ): Promise<{ proof: Groth16Proof; publicSignals: PublicSignals }> {
        return groth16.fullProve(input, wasm, provingKey);
    }

    /** @inheritdoc IGroth16Prover.verify */
    async verify(
        verificationKey: VerificationKey,
        publicSignals: PublicSignals,
        proof: Groth16Proof,
    ): Promise<boolean> {
        return groth16.verify(verificationKey, publicSignals, proof);
    }
}
