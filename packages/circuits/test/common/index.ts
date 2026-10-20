/// <reference path="../types/circomlibjs.d.ts" />
import { Circomkit } from "circomkit";
import { buildPoseidon } from "circomlibjs";
import { LeanIMT } from "@zk-kit/lean-imt";

export { LeanIMT };

// ============================================================================
// CIRCOMKIT CONFIGURATION
// ============================================================================

export const circomkit = new Circomkit({
  version: "2.2.3",
  verbose: false,
  protocol: "groth16",
  inspect: true,
  include: ["./node_modules", "./node_modules/circomlib/circuits"],
});

// circomkit@0.3.4 has a bug in its `instantiate` method: when `WitnessTester`
// passes a circuitConfig directly (as it does in every test), `instantiate`
// falls back to `"2.0.0"` hardcoded instead of honoring `this.config.version`.
// That regenerates the scaffolding circoms under packages/circuits/circuits/test/**
// at the wrong pragma and silently leaves them dirty in git after every test run.
//
// Wrap `WitnessTester` so every config inherits the project's circom version
// unless the test overrides it. Reads from `circomkit.config.version` (set by
// the constructor above) so this stays in sync with the rest of the
// circomkit-driven scaffolding (compile/setup paths via circuits.json).
//
// Tracked upstream: https://github.com/erhant/circomkit/issues/123
// Remove this wrapper once the fix lands in a published release we depend on.
type WitnessTesterParams = Parameters<typeof circomkit.WitnessTester>;
const _originalWitnessTester = circomkit.WitnessTester.bind(circomkit);
circomkit.WitnessTester = ((
  circuit: WitnessTesterParams[0],
  circuitConfig: WitnessTesterParams[1],
  tester?: WitnessTesterParams[2],
) =>
  _originalWitnessTester(
    circuit,
    { version: circomkit.config.version, ...circuitConfig },
    tester,
  )) as typeof circomkit.WitnessTester;

// ============================================================================
// PROTOCOL CONSTANTS
// ============================================================================

/**
 * Authentication type constants for the keystore.
 * Each authType has a different authDigest computation:
 *   - DIRECT_KEY (0): authDigest = Poseidon(0, privateRevocableKey)
 */
export const AUTH_TYPE = {
  DIRECT_KEY: 0n,
} as const;

/**
 * Metadata constant for standard notes in v2.0.
 * Non-zero metadata values are reserved for future note types
 */
export const EMPTY_METADATA = 0n;

/**
 * Domain-separation tag for commitment leaves in the state tree.
 * COMMITMENT_LEAF_TAG = Poseidon(BigInt(Buffer.from("privacy_pools_note","utf-8")))
 */
export const COMMITMENT_LEAF_TAG =
  3791694183000795315792098099581407680958131641292811872617553086713867485913n;

/**
 * Domain-separation tag for nullifier leaves in the state tree.
 * NULLIFIER_LEAF_TAG = Poseidon(BigInt(Buffer.from("privacy_pools_nullifier","utf-8")))
 */
export const NULLIFIER_LEAF_TAG =
  1480564842420020354887207755615370381236762558448265256256653429412951563031n;

// ============================================================================
// INTERFACES & TYPES
// ============================================================================

export interface DepositInputs {
  tokenId: bigint;
  value: bigint;
  context: bigint;
  noteAddressHash: bigint;
  depositSecret: bigint;
}

// ============================================================================
// POSEIDON HASH FUNCTION
// ============================================================================

let poseidonInstance: any = null;

/**
 * Get or create Poseidon instance
 */
export async function getPoseidon() {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

/**
 * Poseidon hash function for any number of inputs.
 * @param inputs - Array of bigint values to hash
 * @returns Poseidon hash as bigint
 */
export async function poseidon(inputs: bigint[]): Promise<bigint> {
  const poseidonFn = await getPoseidon();
  return poseidonFn.F.toObject(poseidonFn(inputs));
}

// ============================================================================
// HELPER FUNCTIONS: TypeScript Reference Implementations
// ============================================================================
// These functions serve as ground truth for verifying circuit correctness.
// They mirror the same logic implemented in the templates.

/**
 * Calculate NoteAddressHash
 *
 * Computes the note address hash that binds the note to its owner.
 *   noteAddressHash = Poseidon(ownerAddress, noteSecret)
 *
 * @param ownerAddress - uint256(ownerAddress)
 * @param noteSecret - Random field element secret
 * @returns noteAddressHash - Hash binding note to owner
 */
export async function calculateNoteAddressHash(
  ownerAddress: bigint,
  noteSecret: bigint,
): Promise<bigint> {
  return await poseidon([ownerAddress, noteSecret]);
}

/**
 * Calculate NoteCommitment
 *
 * The commitment scheme is calculated as follows:
 * 1. precommitment = Poseidon(noteAddressHash, tokenId, value, metadata)
 * 2. commitment = Poseidon(precommitment, label)
 *
 * Mirrors the `NoteCommitment` circuit helper, which does not perform any
 * range checks on its inputs. Callers (Deposit / Transact / Ragequit at
 * the circuit boundary, and analogous test helpers here) are responsible
 * for enforcing `tokenId < 2^160` (INS-1) and `value < 2^128` (AW-M-01).
 *
 * @param noteAddressHash - Poseidon(ownerAddressHash, noteSecret)
 * @param tokenId - uint256(tokenAddress) (range-checked by callers)
 * @param value - Token Amount (range-checked by callers)
 * @param metadata - Note type identifier
 * @param label - Lineage identifier
 * @returns commitment - Final note commitment
 */
export async function calculateNoteCommitment(
  noteAddressHash: bigint,
  tokenId: bigint,
  value: bigint,
  metadata: bigint,
  label: bigint,
): Promise<bigint> {
  // 1. Compute precommitment
  const precommitment = await poseidon([
    noteAddressHash,
    tokenId,
    value,
    metadata,
  ]);

  // 2. Compute final commitment
  const commitment = await poseidon([precommitment, label]);

  return commitment;
}

/**
 * Compute authDigest for Direct Key Authorization (authType = 0)
 *
 * For authType=0, the authDigest is computed as:
 *   authDigest = Poseidon(AUTH_TYPE.DIRECT_KEY, privateRevocableKey)
 *
 * @param privateRevocableKey - Revocable authorization key
 * @returns authDigest - Authorization digest for authType=0
 */
export async function computeAuthDigestDirectKey(
  privateRevocableKey: bigint,
): Promise<bigint> {
  return await poseidon([AUTH_TYPE.DIRECT_KEY, privateRevocableKey]);
}

/**
 * Calculate KeystoreLeaf
 *
 * The computation is done as follows:
 * 1. nullifyingKeyHash = Poseidon(privateNullifyingKey)
 * 2. keystoreLeaf = Poseidon(ownerAddress, nullifyingKeyHash, authDigest)
 *
 * @param ownerAddress - uint256(ownerAddress)
 * @param privateNullifyingKey - Nullifying key
 * @param authDigest - Authorization digest
 * @returns keystoreLeaf - Final leaf for keystore tree
 */
export async function calculateKeystoreLeaf(
  ownerAddress: bigint,
  privateNullifyingKey: bigint,
  authDigest: bigint,
): Promise<bigint> {
  // 1. Hash nullifying key
  const nullifyingKeyHash = await poseidon([privateNullifyingKey]);

  // 2. Compute final leaf
  const keystoreLeaf = await poseidon([
    ownerAddress,
    nullifyingKeyHash,
    authDigest,
  ]);

  return keystoreLeaf;
}

/**
 * Calculate NullifierHash
 *
 * Computes the nullifier for double-spend prevention.
 *   nullifierHash = Poseidon(privateNullifyingKey, commitment)
 *
 * @param privateNullifyingKey - Nullifying key from keystore
 * @param commitment - Note commitment being spent
 * @returns nullifierHash - Unique nullifier for this note
 */
export async function calculateNullifierHash(
  privateNullifyingKey: bigint,
  commitment: bigint,
): Promise<bigint> {
  return await poseidon([privateNullifyingKey, commitment]);
}

/**
 * Calculate LabelHash
 *
 * Computes the label hash for ASP association set tree.
 *   labelHash = Poseidon(label)
 *
 * @param label - Lineage identifier
 * @returns labelHash - Hash of label for ASP tree
 */
export async function calculateLabelHash(label: bigint): Promise<bigint> {
  return await poseidon([label]);
}

/**
 * Calculate domain-tagged commitment leaf for the state tree.
 *   timestampedLeaf = Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp)
 *
 * @param commitment - Note commitment
 * @param timestamp - Block timestamp when commitment was created
 * @returns timestampedLeaf - Hash for state tree insertion
 */
export async function calculateTimestampedLeaf(
  commitment: bigint,
  timestamp: bigint,
): Promise<bigint> {
  return await poseidon([COMMITMENT_LEAF_TAG, commitment, timestamp]);
}

/**
 * Calculate deposit commitment (TypeScript reference)
 *
 * For deposits, the label is derived from the deposit secret:
 *   label = Poseidon(precommitment, depositSecret)
 *   commitment = Poseidon(precommitment, label)
 */
export async function calculateDepositCommitment(
  noteAddressHash: bigint,
  tokenId: bigint,
  value: bigint,
  depositSecret: bigint,
): Promise<bigint> {
  // precommitment = Poseidon(noteAddressHash, tokenId, value, EMPTY_METADATA)
  const precommitment = await poseidon([
    noteAddressHash,
    tokenId,
    value,
    EMPTY_METADATA,
  ]);

  // label = Poseidon(precommitment, depositSecret)
  const label = await poseidon([precommitment, depositSecret]);

  // commitment = Poseidon(precommitment, label)
  const commitment = await poseidon([precommitment, label]);

  return commitment;
}

/**
 * Verify ValueConservation
 *
 * Enforces two levels of conservation:
 * 1. Global: sum(inputValues) === sum(outputValues) + amountOut
 * 2. Per-Label: For each label L, sum(inputValues[L]) >= sum(outputValues[L])
 *
 * @param inputValues - Array of input note values
 * @param inputLabels - Array of input note labels
 * @param outputValues - Array of output note values
 * @param outputLabels - Array of output note labels
 * @param amountOut - Public withdrawal amount
 * @returns Object with validation results and per-label breakdown
 */
export function verifyValueConservation(
  inputValues: bigint[],
  inputLabels: bigint[],
  outputValues: bigint[],
  outputLabels: bigint[],
  amountOut: bigint,
): {
  globalValid: boolean;
  perLabelValid: boolean;
  labelBreakdown: Map<bigint, { inputSum: bigint; outputSum: bigint }>;
} {
  // ===== GLOBAL VALUE CONSERVATION =====
  const totalIn = inputValues.reduce((sum, val) => sum + val, BigInt(0));
  const totalOut =
    outputValues.reduce((sum, val) => sum + val, BigInt(0)) + amountOut;
  const globalValid = totalIn === totalOut;

  // ===== PER-LABEL VALUE CONSERVATION =====
  const labelBreakdown = new Map<
    bigint,
    { inputSum: bigint; outputSum: bigint }
  >();
  const allLabels = new Set([...inputLabels, ...outputLabels]);

  let perLabelValid = true;
  for (const label of Array.from(allLabels)) {
    // Sum inputs for this label
    const inputSum = inputValues
      .filter((_, i) => inputLabels[i] === label)
      .reduce((sum, val) => sum + val, BigInt(0));

    // Sum outputs for this label
    const outputSum = outputValues
      .filter((_, i) => outputLabels[i] === label)
      .reduce((sum, val) => sum + val, BigInt(0));

    labelBreakdown.set(label, { inputSum, outputSum });

    // Check per-label conservation: inputs >= outputs
    if (inputSum < outputSum) {
      perLabelValid = false;
    }
  }

  return { globalValid, perLabelValid, labelBreakdown };
}

// ============================================================================
// MERKLE TREE UTILITIES
// ============================================================================
// LeanIMT is provided by @zk-kit/lean-imt and re-exported above.
// Use padSiblings to pad proof siblings to MAX_DEPTH for circuit input.

/**
 * Pads siblings array with zeros to reach target depth.
 * @param siblings - The sibling path from LeanIMT.generateProof()
 * @param targetDepth - The desired depth to pad to (e.g., STATE_MAX_DEPTH=18, KEYSTORE_MAX_DEPTH=14, ASP_MAX_DEPTH=14)
 * @returns Padded siblings array
 */
export function padSiblings(siblings: bigint[], targetDepth: number): bigint[] {
  const paddedSiblings = [...siblings];
  while (paddedSiblings.length < targetDepth) {
    paddedSiblings.push(BigInt(0));
  }
  return paddedSiblings;
}

/**
 * Creates a LeanIMT Merkle tree with the given leaves.
 * @param leaves - Array of bigint leaves to insert
 * @returns LeanIMT instance with leaves inserted
 */
export async function createTree(leaves: bigint[]): Promise<LeanIMT<bigint>> {
  const poseidonInstance = await getPoseidon();
  const hash = (a: bigint, b: bigint): bigint =>
    poseidonInstance.F.toObject(poseidonInstance([a, b]));
  const tree = new LeanIMT<bigint>(hash);
  tree.insertMany(leaves);
  return tree;
}

// ============================================================================
// TEST UTILITY FUNCTIONS
// ============================================================================

/**
 * Generates a random bigint for testing purposes.
 * @returns A random bigint within safe integer range
 */
export function randomBigInt(): bigint {
  return BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
}

/**
 * Generates a random field element within the BN254 field.
 * Uses 31 bytes instead of 32 to ensure value is always < field size
 * @returns A random bigint < BN254_FIELD_SIZE
 */
export function randomFieldElement(): bigint {
  // Generate random bytes (31 bytes to stay well under field size)
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}

/**
 * Generates a random value suitable for token amounts (< 2^128).
 * @returns A random bigint < 2^128
 */
export function randomValue(): bigint {
  const bytes = new Uint8Array(16); // 128 bits
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}

/**
 * Generates a random tokenId fitting in 160 bits (EVM address width).
 * Use this for top-level circuit inputs (Deposit, Transact, Ragequit)
 * after INS-1, which constrains tokenId to `< 2^160`. Helper-level tests
 * (e.g. NoteCommitment) may still use `randomFieldElement()` since the
 * helper itself does not constrain bit-width.
 * @returns A random bigint < 2^160
 */
export function randomTokenId(): bigint {
  const bytes = new Uint8Array(20); // 160 bits
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}
