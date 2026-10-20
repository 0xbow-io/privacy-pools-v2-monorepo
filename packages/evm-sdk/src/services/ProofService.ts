import type { EVMProof, ProofResult } from "../internal.js";

// Direct import from core-sdk's package entry, not this package's own `../internal.js` barrel —
// see the NOTE in CryptoService.ts: going through the local barrel here is circular
// (internal.ts -> services/index.ts -> this file -> internal.ts) and leaves `AbstractProofService`
// undefined at class-evaluation time.
import { AbstractProofService } from "@privacy-pools-v2/core-sdk";

/**
 * EVM implementation of {@link IProofService} (via {@link AbstractProofService}).
 * Generates and verifies Groth16 ZK proofs using snarkjs (inherited), and reshapes a proof
 * into Solidity verifier calldata.
 */
export class ProofService extends AbstractProofService<EVMProof> {
    /**
     * @inheritdoc IProofService.formatForChain
     */
    formatForChain(proofResult: ProofResult): EVMProof {
        const { proof, publicSignals } = proofResult;

        const pA = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as const;
        // Transpose pB inner coordinates for EVM verification (snarkjs format → EVM format)
        const pB = [
            [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
            [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
        ] as const;
        const pC = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as const;
        const pubSignals = publicSignals.map((s) => BigInt(s));

        return { pA, pB, pC, pubSignals };
    }
}
