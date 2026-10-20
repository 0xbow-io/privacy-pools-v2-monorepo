import type { ICircuitArtifacts, IGroth16Prover, ILogger } from "../internal.js";
import type { Hex } from "./Hex.js";

/** A witness: opaque bag of field elements keyed by signal name. */
export type CircuitInputs = Record<string, Hex | Hex[] | Hex[][]>;

/** A G1 elliptic curve point as [x, y, z] decimal numeric strings. */
export type G1Point = [string, string, string];

/** A G2 elliptic curve point as [[x0, x1], [y0, y1], [z0, z1]] decimal numeric strings. */
export type G2Point = [[string, string], [string, string], [string, string]];

/** A Gt pairing element as a 2×3×2 nested array of decimal numeric strings. */
export type GtElement = [
    [[string, string], [string, string], [string, string]],
    [[string, string], [string, string], [string, string]],
];

/** A Groth16 verification key as exported by snarkjs. */
export interface VerificationKey {
    protocol: string;
    curve: string;
    nPublic: number;
    vk_alpha_1: G1Point;
    vk_beta_2: G2Point;
    vk_gamma_2: G2Point;
    vk_delta_2: G2Point;
    vk_alphabeta_12: GtElement;
    IC: G1Point[];
}

/** A Groth16 proof object as returned by snarkjs. */
export interface Proof {
    pi_a: Hex[];
    pi_b: Hex[][];
    pi_c: Hex[];
    protocol: string;
    curve: string;
}

/** The output of a successful proof generation: the Groth16 proof and its public signals. */
export interface ProofResult {
    /** The Groth16 proof object containing pi_a, pi_b, pi_c curve points. */
    proof: Proof;
    /** The public circuit signals as hex strings, in the order declared by the circuit. */
    publicSignals: Hex[];
}

/** Proof result for the deposit circuit. */
export type DepositProof = ProofResult;

/** Proof result for a transact circuit variant. */
export type TransactProof = ProofResult;

/** Proof result for the ragequit circuit. */
export type RagequitProof = ProofResult;

/** A Groth16 proof formatted for EVM verification. */
export interface EVMProof {
    /** G1 point A as two bigint coordinates. */
    pA: readonly [bigint, bigint];
    /** G2 point B as a 2×2 bigint matrix (inner coordinates transposed from snarkjs). */
    pB: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
    /** G1 point C as two bigint coordinates. */
    pC: readonly [bigint, bigint];
    /** Public signals converted to bigint. */
    pubSignals: readonly bigint[];
}

/**
 * A Groth16 proof formatted for Stellar/Soroban verification, matching
 * the reference implementation's `convertProof`/`convertSignals` output shape exactly (same
 * field names, same byte layout) — a future `Stellar*ChainAdapter` still needs to encode these
 * into the contract's actual ScVal call arguments (each `pubSignals` entry becomes its own
 * separately-typed parameter on-chain, not a bundled array); this type is the pre-ScVal
 * intermediate `AbstractProofService.formatForChain`'s pure reshaping step produces.
 */
export interface StellarProof {
    /** G1 point A: 64 bytes (32-byte BE x ‖ 32-byte BE y), as 0x-prefixed hex. */
    a: Hex;
    /**
     * G2 point B: 128 bytes (x.c1 ‖ x.c0 ‖ y.c1 ‖ y.c0, each 32-byte BE) — imaginary component
     * first per snarkjs's Fq2 convention, matching `EVMProof.pB`'s identical transpose.
     */
    b: Hex;
    /** G1 point C: 64 bytes (32-byte BE x ‖ 32-byte BE y), as 0x-prefixed hex. */
    c: Hex;
    /** Public signals converted to bigint, in circuit output order. */
    pubSignals: readonly bigint[];
}

/** Configuration for ProofService construction. */
export interface ProofServiceConfig {
    circuitArtifacts: ICircuitArtifacts;
    groth16Prover: IGroth16Prover;
}

/** Dependencies for ProofService construction. */
export interface ProofServiceDependencies {
    logger?: ILogger;
}

/** Cached WASM and proving key for a circuit. */
export interface CachedCircuitArtifacts {
    wasm: Uint8Array;
    provingKey: Uint8Array;
}
