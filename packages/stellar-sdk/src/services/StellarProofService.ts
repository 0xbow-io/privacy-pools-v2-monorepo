import type { Hex, ProofResult, StellarProof } from "../internal.js";
import { bigintToHex } from "../internal.js";

// `extends` needs the base class value synchronously at module-evaluation time. Going through
// this package's own `../internal.js` barrel creates a circular import here (internal.ts ->
// services/index.ts -> this file -> internal.ts) that leaves `AbstractProofService` undefined at
// class-evaluation time (AbstractProofService itself lives in core-sdk now, not stellar-sdk).
// Importing directly from the dependency's own package entry (no cycle: core-sdk never imports
// stellar-sdk) is the fix, mirroring evm-sdk's identical `ProofService.ts` precedent.
import { AbstractProofService } from "@privacy-pools-v2/core-sdk";

/**
 * Stellar implementation of {@link IProofService} (via {@link AbstractProofService}).
 * Generates and verifies Groth16 ZK proofs using snarkjs (inherited), and reshapes a proof into
 * the byte layout Soroban's Groth16 verifier expects — matching
 * the reference implementation's `convertProof`/`convertSignals` exactly (verified
 * byte-for-byte against the live reference implementation, not merely read from its source).
 *
 * Returns the pre-ScVal `{a, b, c, pubSignals}` intermediate, not XDR — a `Stellar*ChainAdapter`
 * still owns turning this into the contract's actual `Groth16Proof` ScVal map (alphabetical
 * `a`/`b`/`c` Symbol keys per Soroban's `#[contracttype]` encoding) and decomposing `pubSignals`
 * into the call's individually-typed parameters (each a separate `u256`/`u128` argument on-chain,
 * never a bundled array) — the same split `EvmPoolVaultChainAdapter` has for `EVMProof`.
 */
export class StellarProofService extends AbstractProofService<StellarProof> {
    /**
     * @inheritdoc IProofService.formatForChain
     */
    formatForChain(proofResult: ProofResult): StellarProof {
        const { proof, publicSignals } = proofResult;

        const a = this.g1ToBytes(proof.pi_a);
        const b = this.g2ToBytes(proof.pi_b);
        const c = this.g1ToBytes(proof.pi_c);
        const pubSignals = publicSignals.map((s) => BigInt(s));

        return { a, b, c, pubSignals };
    }

    /** Packs a snarkjs G1 point `[x, y]` into 64 bytes (32-byte BE x ‖ 32-byte BE y). */
    private g1ToBytes(point: Hex[]): Hex {
        const x = BigInt(point[0]);
        const y = BigInt(point[1]);
        return ("0x" + this.toBytes32(x) + this.toBytes32(y)) as Hex;
    }

    /**
     * Packs a snarkjs G2 point `[[x.c0, x.c1], [y.c0, y.c1]]` into 128 bytes, imaginary
     * component first per component (x.c1 ‖ x.c0 ‖ y.c1 ‖ y.c0) — matches `EVMProof.pB`'s
     * identical transpose and the reference implementation's `g2ToBytes`.
     */
    private g2ToBytes(point: Hex[][]): Hex {
        const xC0 = BigInt(point[0][0]);
        const xC1 = BigInt(point[0][1]);
        const yC0 = BigInt(point[1][0]);
        const yC1 = BigInt(point[1][1]);
        return ("0x" +
            this.toBytes32(xC1) +
            this.toBytes32(xC0) +
            this.toBytes32(yC1) +
            this.toBytes32(yC0)) as Hex;
    }

    /** 32-byte big-endian hex encoding of a field element, without the `0x` prefix. */
    private toBytes32(value: bigint): string {
        return bigintToHex(value).slice(2);
    }
}
