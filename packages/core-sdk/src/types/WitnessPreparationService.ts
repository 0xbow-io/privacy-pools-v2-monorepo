import type { ZodType } from "zod";

import type {
    Hex,
    IHashService,
    ILogger,
    IMerkleService,
    INoteComputationService,
    Note,
    PendingNote,
    Secret,
} from "../internal.js";

/**
 * Configuration for the WitnessPreparationService.
 */
export interface WitnessPreparationServiceConfig {
    /** The note computation service for shared hash chain computations. */
    noteComputationService: INoteComputationService;
    /** The hash service for witness-internal Poseidon hashes. */
    hashService: IHashService;
    /** The merkle service used for merkle proof generation. */
    merkleService: IMerkleService;
    /**
     * Validates `inputNotes`/`changeNotes`/`recipientNotes`/`note`'s embedded `tokenId`/
     * `ownerAddress` fields against the chain's real address shape (those two fields are never
     * read for witness construction — see `makeBuildTransactWitnessInputsSchema`'s doc comment —
     * so this only needs to accept the caller's real values, not convert them). Untyped beyond
     * `string` because `WitnessPreparationService` itself is not generic over `TAddress` — its
     * `Note[]` params are concretely `Note<Address>` at the type level even on a Stellar builder
     * (see `TransactOrchestrator`'s `inputNotes as Note[]` cast). Defaults to the EVM-shaped
     * `AddressSchema` when omitted.
     */
    addressSchema?: ZodType<string>;
}

/**
 * Dependencies for the WitnessPreparationService.
 */
export interface WitnessPreparationServiceDependencies {
    logger?: ILogger;
}

/**
 * Inputs for building a deposit witness.
 *
 * Must stay a `type`, not an `interface`: test code casts a `Record<string, unknown>` through
 * it, which needs the wider structural assignability a `type` alias gets and a declared
 * `interface` does not.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see doc comment above.
export type BuildDepositWitnessInputs = {
    /** Pre-computed noteAddressHash = Poseidon(recipientAddress, noteSecret). */
    noteAddressHash: Hex;
    /** Token being deposited. */
    tokenId: Hex;
    /** Amount being deposited. */
    value: Hex;
    /** Commitment to deposit details. */
    context: Hex;
    /** Random secret used for private label computation. */
    depositSecret: Secret;
};

/**
 * Parameters for a single output note.
 */
export interface OutputNoteParams {
    /** Pre-computed Poseidon(recipientAddress, noteSecret). */
    noteAddressHash: Hex;
    /** Output value. */
    value: Hex;
    /** Output label. */
    label: Hex;
}

/**
 * Inputs for building a transact witness.
 */
export interface BuildTransactWitnessInputs {
    /** The input notes being spent. */
    inputNotes: Note[];
    /** Change notes (owned by the sender). */
    changeNotes: PendingNote[];
    /** Recipient notes (not owned by the sender). */
    recipientNotes: PendingNote[];
    /** The sender's address. */
    ownerAddress: Hex;
    /** For nullifier computation. */
    privateNullifyingKey: Secret;
    /** For authorizerDigest recomputation inside the circuit. */
    privateRevocableKey: Secret;
    /** Token ID (single token per tx). */
    tokenId: Hex;
    /** Public withdrawal amount. 0 for pure transfers. */
    amountOut: Hex;
    /** Token being withdrawn. address(0) for pure transfer. */
    tokenIdOut: Hex;
    /** Commitment to withdrawal details. */
    context: Hex;
    /** All leaves of the state merkle tree. */
    stateLeaves: Hex[];
    /** All leaves of the keystore merkle tree. */
    keystoreLeaves: Hex[];
    /** All leaves of the ASP association set merkle tree. */
    aspLeaves: Hex[];
    /**
     * When `true`, the owner's keystore leaf is NOT yet on-chain — this witness accompanies a
     * bundled `registerAndRelay` where registration and withdrawal land in the same transaction.
     * The keystore membership proof is anchored to the PREDICTED post-insertion root: the owner's
     * leaf is appended to `keystoreLeaves` at the next index, so `keystoreRoot` equals the root the
     * tree will have after `setAuthPolicyWithSig` inserts it. Optimistic — any concurrent keystore
     * mutation invalidates the prediction (submit via private orderflow so a stale-root revert
     * costs no gas). Omit/`false` for the standard path where the leaf is already on-chain.
     */
    pendingKeystoreRegistration?: boolean;
}

/**
 * Inputs for building a ragequit witness.
 */
export interface BuildRagequitWitnessInputs {
    /** The note being exited. */
    note: Note;
    /** The owner's address. */
    ownerAddress: Hex;
    /** For nullifier computation. */
    privateNullifyingKey: Secret;
    /** For authorizerDigest recomputation. */
    privateRevocableKey: Secret;
    /** Token identifier. */
    tokenId: Hex;
    /** Lineage identifier for ASP tracking. */
    label: Hex;
    /** Keystore tree leaves. */
    keystoreLeaves: Hex[];
}

/**
 * Typed circuit inputs for the deposit circuit.
 *
 * Must stay a `type`, not an `interface`: passed to call sites typed against `CircuitInputs`
 * (an index-signature type, `Record<string, unknown>`-shaped) — only a `type` alias structurally
 * satisfies that, a declared `interface` does not.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see doc comment above.
export type DepositCircuitInputs = {
    tokenId: Hex;
    value: Hex;
    context: Hex;
    noteAddressHash: Hex;
    depositSecret: Hex;
};

/**
 * Typed circuit inputs for the transact circuit.
 *
 * Must stay a `type`, not an `interface` — see `DepositCircuitInputs`'s own doc comment above;
 * same `CircuitInputs` constraint.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see doc comment above.
export type TransactCircuitInputs = {
    stateRoot: Hex;
    keystoreRoot: Hex;
    associationSetRoot: Hex;
    amountOut: Hex;
    tokenIdOut: Hex;
    context: Hex;
    ownerAddress: Hex;
    privateNullifyingKey: Hex;
    privateRevocableKey: Hex;
    keystoreLeafIndex: Hex;
    keystoreSiblings: Hex[];
    keystoreTreeDepth: Hex;
    noteSecret: Hex[];
    value: Hex[];
    tokenId: Hex;
    label: Hex[];
    stateLeafIndex: Hex[];
    stateSiblings: Hex[][];
    stateTreeDepth: Hex[];
    associationSetLeafIndex: Hex[];
    associationSetSiblings: Hex[][];
    associationSetTreeDepth: Hex[];
    timestamp: Hex[];
    outputNoteAddressHash: Hex[];
    outputValue: Hex[];
    outputLabel: Hex[];
};

/**
 * Typed circuit inputs for the ragequit circuit.
 *
 * Must stay a `type`, not an `interface` — see `DepositCircuitInputs`'s own doc comment above;
 * same `CircuitInputs` constraint.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see doc comment above.
export type RagequitCircuitInputs = {
    keystoreRoot: Hex;
    ownerAddress: Hex;
    value: Hex;
    tokenId: Hex;
    label: Hex;
    noteSecret: Hex;
    metadata: Hex;
    privateNullifyingKey: Hex;
    privateRevocableKey: Hex;
    keystoreLeafIndex: Hex;
    keystoreSiblings: Hex[];
    keystoreTreeDepth: Hex;
};

/**
 * Result of building a transact witness.
 */
export interface TransactWitness {
    /** The structured private inputs for the transact circuit. */
    witness: TransactCircuitInputs;
    /** Computed commitments for all output notes. */
    outputCommitments: Hex[];
    /** Computed nullifier hashes for all input notes. */
    nullifiers: Hex[];
}

/**
 * Result of building a ragequit witness.
 */
export interface RagequitWitness {
    /** The structured private inputs for the ragequit circuit. */
    witness: RagequitCircuitInputs;
    /** The computed nullifier hash. */
    nullifierHash: Hex;
    /** The reconstructed commitment. */
    commitment: Hex;
}
