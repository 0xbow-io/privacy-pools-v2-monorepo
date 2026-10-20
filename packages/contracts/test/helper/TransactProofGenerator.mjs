#!/usr/bin/env node
/**
 * FFI-compatible transact proof generator for Foundry's vm.ffi().
 *
 * Usage: node test/helper/TransactProofGenerator.mjs <circuitName> '<json>'
 *
 * circuitName: e.g. "transact_2x2"
 *
 * Input JSON keys: stateRoot, keystoreRoot, associationSetRoot, amountOut, tokenIdOut,
 *   context, ownerAddress, privateNullifyingKey, privateRevocableKey, keystoreLeafIndex,
 *   keystoreSiblings (array), keystoreTreeDepth, noteSecret (array), value (array),
 *   label (array), tokenId, stateLeafIndex (array), stateSiblings (2D array),
 *   stateTreeDepth (array), associationSetLeafIndex (array), associationSetSiblings (2D array),
 *   associationSetTreeDepth (array), timestamp (array), outputNoteAddressHash (array),
 *   outputValue (array), outputLabel (array)
 * All values as decimal or hex strings.
 *
 * On success: writes ABI-encoded TransactProof bytes to stdout (hex with 0x prefix).
 *   Encoding: (uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[][] pubSignals)
 * On failure: exits with code 1, no stdout output.
 */
import { encodeAbiParameters } from "viem";
import {
  withSilentStdout,
  validateStringInputs,
  generateProof,
  exportSolidityCalldata,
} from "./proof-utils.mjs";

// Number of fixed (non-array) public inputs in the transact circuit:
// stateRoot, keystoreRoot, associationSetRoot, amountOut, tokenIdOut, context
const NUM_FIXED_PUBLIC_INPUTS = 6;

/**
 * Reshape flat snarkjs publicSignals into 2D uint256[][] for TransactProof.
 *
 * N = number of input notes consumed (nullifiers)
 * M = number of output notes created (commitments)
 *
 * snarkjs outputs public signals in this order:
 * - [0..N-1]: nullifierHashes (circuit outputs)
 * - [N..N+M-1]: outputCommitments (circuit outputs)
 * - [N+M..N+M+5]: public inputs (stateRoot, keystoreRoot, associationSetRoot, amountOut, tokenIdOut, context)
 *
 * TransactVerifier / ProofLibV2 2D layout:
 * - [0] = nullifierHashes[N]
 * - [1] = outputCommitments[M]
 * - [2] = [stateRoot]
 * - [3] = [keystoreRoot]
 * - [4] = [associationSetRoot]
 * - [5] = [amountOut]
 * - [6] = [tokenIdOut]
 * - [7] = [context]
 */
function reshapeTransactPubSignals(flatSignals, nInputs, mOutputs) {
  const expectedLength = NUM_FIXED_PUBLIC_INPUTS + nInputs + mOutputs;
  if (flatSignals.length !== expectedLength) {
    throw new Error(
      `Expected ${expectedLength} public signals for transact_${nInputs}x${mOutputs}, got ${flatSignals.length}`,
    );
  }

  const nullifierHashes = flatSignals.slice(0, nInputs).map(BigInt);
  const outputCommitments = flatSignals.slice(nInputs, nInputs + mOutputs).map(BigInt);

  const fixedStart = nInputs + mOutputs;
  const fixedInputs = Array.from({ length: NUM_FIXED_PUBLIC_INPUTS }, (_, i) => [
    BigInt(flatSignals[fixedStart + i]),
  ]);

  return [nullifierHashes, outputCommitments, ...fixedInputs];
}

async function main() {
  const circuitName = process.argv[2];
  const jsonStr = process.argv[3];

  if (!circuitName || !jsonStr) process.exit(1);

  // Extract nInputs and mOutputs from circuit name
  const match = circuitName.match(/transact_(\d+)x(\d+)/);
  if (!match) process.exit(1);
  const nInputs = parseInt(match[1]);
  const mOutputs = parseInt(match[2]);

  const raw = JSON.parse(jsonStr);
  validateStringInputs(raw);

  const inputs = {
    // Public inputs
    stateRoot: BigInt(raw.stateRoot),
    keystoreRoot: BigInt(raw.keystoreRoot),
    associationSetRoot: BigInt(raw.associationSetRoot),
    amountOut: BigInt(raw.amountOut),
    tokenIdOut: BigInt(raw.tokenIdOut),
    context: BigInt(raw.context),

    // Authorization
    ownerAddress: BigInt(raw.ownerAddress),
    privateNullifyingKey: BigInt(raw.privateNullifyingKey),
    privateRevocableKey: BigInt(raw.privateRevocableKey),
    keystoreLeafIndex: BigInt(raw.keystoreLeafIndex),
    keystoreSiblings: raw.keystoreSiblings.map(BigInt),
    keystoreTreeDepth: BigInt(raw.keystoreTreeDepth),

    // Input notes
    noteSecret: raw.noteSecret.map(BigInt),
    value: raw.value.map(BigInt),
    label: raw.label.map(BigInt),
    tokenId: BigInt(raw.tokenId),
    stateLeafIndex: raw.stateLeafIndex.map(BigInt),
    stateSiblings: raw.stateSiblings.map((row) => row.map(BigInt)),
    stateTreeDepth: raw.stateTreeDepth.map(BigInt),
    associationSetLeafIndex: raw.associationSetLeafIndex.map(BigInt),
    associationSetSiblings: raw.associationSetSiblings.map((row) => row.map(BigInt)),
    associationSetTreeDepth: raw.associationSetTreeDepth.map(BigInt),
    timestamp: raw.timestamp.map(BigInt),

    // Output notes
    outputNoteAddressHash: raw.outputNoteAddressHash.map(BigInt),
    outputValue: raw.outputValue.map(BigInt),
    outputLabel: raw.outputLabel.map(BigInt),
  };

  const silentGenerateProof = withSilentStdout(generateProof);
  const { proof, publicSignals } = await silentGenerateProof(circuitName, inputs);

  const calldataStr = await (await import("snarkjs")).groth16.exportSolidityCallData(proof, publicSignals);
  const [pA, pB, pC, pubSignals] = JSON.parse(`[${calldataStr}]`);

  // Reshape flat pubSignals into 2D for TransactProof encoding
  const pubSignals2D = reshapeTransactPubSignals(pubSignals, nInputs, mOutputs);

  const encoded = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "_pA", type: "uint256[2]" },
          { name: "_pB", type: "uint256[2][2]" },
          { name: "_pC", type: "uint256[2]" },
          { name: "_pubSignals", type: "uint256[][]" },
        ],
      },
    ],
    [
      {
        _pA: pA.map(BigInt),
        _pB: pB.map((row) => row.map(BigInt)),
        _pC: pC.map(BigInt),
        _pubSignals: pubSignals2D,
      },
    ],
  );

  process.stdout.write(encoded);
  process.exit(0);
}

main().catch(() => process.exit(1));
