// ============================================================================
// Transact Circuit - Test Suite
// ============================================================================
// Description:
//   Tests the Transact circuit that enables private transfers and public withdrawals.
//
// Coverage:
//   - Authorization verification via keystore
//   - Input note verification (commitment reconstruction + Merkle proof)
//   - ASP compliance check (label hash inclusion proof)
//   - Nullifier generation for double-spend prevention
//   - Output note construction
//   - Value conservation (global and per-label)
//   - Payload binding
//   - Multiple configurations: all 25 NxM combinations (1..5 inputs × 1..5 outputs)
//   - Soundness: Invalid proofs rejected
//   - Edge cases: Zero values, withdrawal vs transfer modes
// ============================================================================

import { expect } from "chai";
import { WitnessTester } from "circomkit";
import {
  circomkit,
  getPoseidon,
  calculateNoteCommitment,
  calculateKeystoreLeaf,
  computeAuthDigestDirectKey,
  calculateNoteAddressHash,
  calculateNullifierHash,
  calculateLabelHash,
  calculateTimestampedLeaf,
  randomFieldElement,
  randomTokenId,
  randomValue,
  padSiblings,
  LeanIMT,
  EMPTY_METADATA,
} from "./common/index.js";

// Test constants - Tree depths (per conversation: state=18, keystore=14, ASP=14)
const STATE_MAX_DEPTH = 18;
const KEYSTORE_MAX_DEPTH = 14;
const ASSOCIATION_SET_MAX_DEPTH = 14;
const LABEL_A = 1n;
const LABEL_B = 2n;
const LABEL_C = 3n;

describe("Transact Circuit", () => {
  let poseidonFn: any;

  // Hash function for Merkle trees
  const hash = (a: bigint, b: bigint): bigint => {
    return poseidonFn.F.toObject(poseidonFn([a, b]));
  };

  before(async () => {
    poseidonFn = await getPoseidon();
  });

  // ============================================================================
  // HELPER TYPES & FUNCTIONS
  // ============================================================================

  function createTree(leaves: bigint[]): LeanIMT<bigint> {
    const tree = new LeanIMT<bigint>(hash);
    tree.insertMany(leaves);
    return tree;
  }

  function getProofInputs(
    tree: LeanIMT<bigint>,
    leafIndex: number,
    maxDepth: number,
  ) {
    const proof = tree.generateProof(leafIndex);
    const siblings = padSiblings(proof.siblings, maxDepth);
    return {
      leaf: proof.leaf,
      index: BigInt(proof.index),
      siblings: siblings,
      depth: BigInt(proof.siblings.length),
    };
  }

  /**
   * Helper to normalize circuit outputs.
   */
  function toArray(value: unknown): bigint[] {
    if (Array.isArray(value)) {
      return value as bigint[];
    }
    return [value as bigint];
  }

  /**
   * Creates a complete set of valid inputs for the circuit
   */
  async function createValidInputs(config: {
    nInputs: number;
    mOutputs: number;
    inputValues: bigint[];
    inputLabels: bigint[];
    outputValues: bigint[];
    outputLabels: bigint[];
    amountOut: bigint;
    dummyLeavesBetween?: number[];
  }) {
    const {
      nInputs,
      mOutputs,
      inputValues,
      inputLabels,
      outputValues,
      outputLabels,
      amountOut,
    } = config;

    // Generate keys
    const ownerAddress = randomFieldElement();
    const privateNullifyingKey = randomFieldElement();
    const privateRevocableKey = randomFieldElement();
    const tokenId = randomTokenId();

    // Compute authDigest and keystore leaf
    const authDigest = await computeAuthDigestDirectKey(privateRevocableKey);
    const keystoreLeaf = await calculateKeystoreLeaf(
      ownerAddress,
      privateNullifyingKey,
      authDigest,
    );

    // Build keystore tree with a second dummy leaf to ensure depth > 0,
    // which is needed for Merkle proof verification tests to properly reject tampered inputs
    const keystoreTree = createTree([keystoreLeaf, randomFieldElement()]);
    const keystoreProof = getProofInputs(keystoreTree, 0, KEYSTORE_MAX_DEPTH);

    // Build input notes
    const noteSecrets: bigint[] = [];
    const inputCommitments: bigint[] = [];
    const timestamps: bigint[] = [];

    for (let i = 0; i < nInputs; i++) {
      const noteSecret = randomFieldElement();
      noteSecrets.push(noteSecret);

      const noteAddressHash = await calculateNoteAddressHash(
        ownerAddress,
        noteSecret,
      );
      const commitment = await calculateNoteCommitment(
        noteAddressHash,
        tokenId,
        inputValues[i],
        EMPTY_METADATA,
        inputLabels[i],
      );
      inputCommitments.push(commitment);

      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      timestamps.push(timestamp);
    }

    // Build state tree with timestamped leaves
    const timestampedLeaves: bigint[] = [];
    const userLeafIndices: number[] = [];
    const dummyLeavesBetween = config.dummyLeavesBetween;

    for (let i = 0; i < nInputs; i++) {
      // Insert dummy leaves before this user's note (if specified)
      if (dummyLeavesBetween && dummyLeavesBetween[i] > 0) {
        for (let d = 0; d < dummyLeavesBetween[i]; d++) {
          timestampedLeaves.push(randomFieldElement());
        }
      }

      // Track the actual index of this user note
      userLeafIndices.push(timestampedLeaves.length);

      const timestampedLeaf = await calculateTimestampedLeaf(
        inputCommitments[i],
        timestamps[i],
      );
      timestampedLeaves.push(timestampedLeaf);
    }
    const stateTree = createTree(timestampedLeaves);

    // Build ASP tree with label hashes
    const labelHashes: bigint[] = [];
    for (let i = 0; i < nInputs; i++) {
      const labelHash = await calculateLabelHash(inputLabels[i]);
      labelHashes.push(labelHash);
    }
    // Add unique label hashes to ASP tree
    const uniqueLabelHashes = [...new Set(labelHashes)];
    const associationSetTree = createTree(uniqueLabelHashes);

    // Build commitment proofs and ASP proofs for each input
    const stateSiblings: bigint[][] = [];
    const stateLeafIndices: bigint[] = [];
    const stateTreeDepths: bigint[] = [];
    const associationSetSiblings: bigint[][] = [];
    const associationSetLeafIndices: bigint[] = [];
    const associationSetTreeDepths: bigint[] = [];

    for (let i = 0; i < nInputs; i++) {
      // Commitment proof (use actual leaf index when dummy leaves are interleaved)
      const leafIndex = dummyLeavesBetween ? userLeafIndices[i] : i;
      const commitProof = getProofInputs(stateTree, leafIndex, STATE_MAX_DEPTH);
      stateSiblings.push(commitProof.siblings);
      stateLeafIndices.push(commitProof.index);
      stateTreeDepths.push(commitProof.depth);

      // ASP proof - find the index of this label's hash in the ASP tree
      const labelHash = await calculateLabelHash(inputLabels[i]);
      const associationSetIndex = uniqueLabelHashes.findIndex(
        (h) => h === labelHash,
      );
      const associationSetProof = getProofInputs(
        associationSetTree,
        associationSetIndex,
        ASSOCIATION_SET_MAX_DEPTH,
      );
      associationSetSiblings.push(associationSetProof.siblings);
      associationSetLeafIndices.push(associationSetProof.index);
      associationSetTreeDepths.push(associationSetProof.depth);
    }

    // Build output notes
    const outputNoteAddressHashes: bigint[] = [];

    for (let j = 0; j < mOutputs; j++) {
      const outputOwnerAddress = randomFieldElement();
      const outputNoteSecret = randomFieldElement();
      const outputNoteAddressHash = await calculateNoteAddressHash(
        outputOwnerAddress,
        outputNoteSecret,
      );
      outputNoteAddressHashes.push(outputNoteAddressHash);
    }

    // Other public inputs
    const tokenIdOut = tokenId;
    const context = randomFieldElement();

    return {
      // Public inputs
      stateRoot: stateTree.root,
      keystoreRoot: keystoreTree.root,
      associationSetRoot: associationSetTree.root,
      amountOut,
      tokenIdOut,
      context,

      // Authorization
      ownerAddress,
      privateNullifyingKey,
      privateRevocableKey,
      keystoreLeafIndex: keystoreProof.index,
      keystoreSiblings: keystoreProof.siblings,
      keystoreTreeDepth: keystoreProof.depth,

      // Per input note
      noteSecret: noteSecrets,
      value: inputValues,
      tokenId,
      label: inputLabels,
      stateLeafIndex: stateLeafIndices,
      stateSiblings,
      stateTreeDepth: stateTreeDepths,
      associationSetLeafIndex: associationSetLeafIndices,
      associationSetSiblings,
      associationSetTreeDepth: associationSetTreeDepths,
      timestamp: timestamps,

      // Per output note
      outputNoteAddressHash: outputNoteAddressHashes,
      outputValue: outputValues,
      outputLabel: outputLabels,

      // For verification
      _inputCommitments: inputCommitments,
      _authDigest: authDigest,
    };
  }

  // ============================================================================
  // TEST SUITE: All NxM Configurations - Happy Path
  // ============================================================================

  describe("All NxM Configurations", () => {
    const CONFIGS: Array<{ nInputs: number; mOutputs: number }> = [];
    for (let n = 1; n <= 5; n++) {
      for (let m = 1; m <= 5; m++) {
        CONFIGS.push({ nInputs: n, mOutputs: m });
      }
    }

    for (const { nInputs, mOutputs } of CONFIGS) {
      describe(`Configuration: ${nInputs} input(s), ${mOutputs} output(s)`, () => {
        let circuit: WitnessTester<
          [
            "stateRoot",
            "keystoreRoot",
            "associationSetRoot",
            "amountOut",
            "tokenIdOut",
            "context",
            "ownerAddress",
            "privateNullifyingKey",
            "privateRevocableKey",
            "keystoreLeafIndex",
            "keystoreSiblings",
            "keystoreTreeDepth",
            "noteSecret",
            "value",
            "tokenId",
            "label",
            "stateLeafIndex",
            "stateSiblings",
            "stateTreeDepth",
            "associationSetLeafIndex",
            "associationSetSiblings",
            "associationSetTreeDepth",
            "timestamp",
            "outputNoteAddressHash",
            "outputValue",
            "outputLabel",
          ],
          ["nullifierHashes", "outputCommitments"]
        >;

        before(async () => {
          circuit = await circomkit.WitnessTester(
            `Transact_${nInputs}_${mOutputs}`,
            {
              file: "templates/Transact",
              template: "Transact",
              params: [
                nInputs,
                mOutputs,
                STATE_MAX_DEPTH,
                KEYSTORE_MAX_DEPTH,
                ASSOCIATION_SET_MAX_DEPTH,
              ],
              dir: "test/main",
            },
          );
        });

        it(`✨ should accept valid pure transfer (${nInputs}x${mOutputs})`, async () => {
          // Distribute a total value across inputs and outputs
          const totalValue = 10000n;
          const inputValues: bigint[] = [];
          const inputLabels: bigint[] = [];
          let remainingInput = totalValue;

          for (let i = 0; i < nInputs; i++) {
            if (i === nInputs - 1) {
              inputValues.push(remainingInput);
            } else {
              const val = totalValue / BigInt(nInputs);
              inputValues.push(val);
              remainingInput -= val;
            }
            inputLabels.push(LABEL_A);
          }

          const outputValues: bigint[] = [];
          const outputLabels: bigint[] = [];
          let remainingOutput = totalValue;

          for (let j = 0; j < mOutputs; j++) {
            if (j === mOutputs - 1) {
              outputValues.push(remainingOutput);
            } else {
              const val = totalValue / BigInt(mOutputs);
              outputValues.push(val);
              remainingOutput -= val;
            }
            outputLabels.push(LABEL_A);
          }

          const inputs = await createValidInputs({
            nInputs,
            mOutputs,
            inputValues,
            inputLabels,
            outputValues,
            outputLabels,
            amountOut: 0n,
          });

          const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

          await circuit.expectPass(circuitInputs);
        });

        it(`✨ should accept valid withdrawal (${nInputs}x${mOutputs})`, async () => {
          const totalValue = 10000n;
          const withdrawAmount = 1000n;
          const remainingValue = totalValue - withdrawAmount;

          const inputValues: bigint[] = [];
          const inputLabels: bigint[] = [];
          let remainingInput = totalValue;

          for (let i = 0; i < nInputs; i++) {
            if (i === nInputs - 1) {
              inputValues.push(remainingInput);
            } else {
              const val = totalValue / BigInt(nInputs);
              inputValues.push(val);
              remainingInput -= val;
            }
            inputLabels.push(LABEL_A);
          }

          const outputValues: bigint[] = [];
          const outputLabels: bigint[] = [];
          let remainingOutput = remainingValue;

          for (let j = 0; j < mOutputs; j++) {
            if (j === mOutputs - 1) {
              outputValues.push(remainingOutput);
            } else {
              const val = remainingValue / BigInt(mOutputs);
              outputValues.push(val);
              remainingOutput -= val;
            }
            outputLabels.push(LABEL_A);
          }

          const inputs = await createValidInputs({
            nInputs,
            mOutputs,
            inputValues,
            inputLabels,
            outputValues,
            outputLabels,
            amountOut: withdrawAmount,
          });

          const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

          await circuit.expectPass(circuitInputs);
        });
      });
    }
  });

  // ============================================================================
  // TEST SUITE: Configuration (1, 2) - 1 input, 2 outputs
  // ============================================================================

  describe("Configuration: 1 input, 2 outputs", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_1_2", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          1,
          2,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    describe("Completeness - Valid Proofs", () => {
      it("✨ should accept valid pure transfer (amountOut = 0)", async () => {
        const inputs = await createValidInputs({
          nInputs: 1,
          mOutputs: 2,
          inputValues: [1000n],
          inputLabels: [LABEL_A],
          outputValues: [600n, 400n],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 0n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        const witness = await circuit.compute(circuitInputs, [
          "nullifierHashes",
          "outputCommitments",
        ]);

        // Normalize outputs
        const nullifierHashes = toArray(witness.nullifierHashes);
        const outputCommitments = toArray(witness.outputCommitments);

        // Verify nullifier is correctly computed
        const expectedNullifier = await calculateNullifierHash(
          inputs.privateNullifyingKey,
          _inputCommitments[0],
        );
        expect(nullifierHashes[0]).to.equal(expectedNullifier);

        // Verify output commitments are correctly computed
        for (let j = 0; j < 2; j++) {
          const expectedCommitment = await calculateNoteCommitment(
            inputs.outputNoteAddressHash[j],
            inputs.tokenId,
            inputs.outputValue[j],
            EMPTY_METADATA,
            inputs.outputLabel[j],
          );
          expect(outputCommitments[j]).to.equal(expectedCommitment);
        }
      });

      it("✨ should accept valid withdrawal (amountOut > 0)", async () => {
        const inputs = await createValidInputs({
          nInputs: 1,
          mOutputs: 2,
          inputValues: [1000n],
          inputLabels: [LABEL_A],
          outputValues: [400n, 100n],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 500n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        await circuit.expectPass(circuitInputs);
      });

      it("✨ should accept transfer with zero-value dummy output", async () => {
        const inputs = await createValidInputs({
          nInputs: 1,
          mOutputs: 2,
          inputValues: [1000n],
          inputLabels: [LABEL_A],
          outputValues: [1000n, 0n], // Second output is dummy
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 0n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        await circuit.expectPass(circuitInputs);
      });
    });

    describe("Nullifier Generation", () => {
      it("✨ should generate deterministic nullifiers", async () => {
        const inputs = await createValidInputs({
          nInputs: 1,
          mOutputs: 2,
          inputValues: [1000n],
          inputLabels: [LABEL_A],
          outputValues: [600n, 400n],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 0n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        // Compute twice
        const witness1 = await circuit.compute(circuitInputs, [
          "nullifierHashes",
        ]);
        const witness2 = await circuit.compute(circuitInputs, [
          "nullifierHashes",
        ]);

        const nullifiers1 = toArray(witness1.nullifierHashes);
        const nullifiers2 = toArray(witness2.nullifierHashes);

        expect(nullifiers1[0]).to.equal(nullifiers2[0]);
      });

      it("✨ should generate unique nullifiers for different notes", async () => {
        const inputs1 = await createValidInputs({
          nInputs: 1,
          mOutputs: 2,
          inputValues: [1000n],
          inputLabels: [LABEL_A],
          outputValues: [600n, 400n],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 0n,
        });

        const inputs2 = await createValidInputs({
          nInputs: 1,
          mOutputs: 2,
          inputValues: [1000n],
          inputLabels: [LABEL_A],
          outputValues: [600n, 400n],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 0n,
        });

        const {
          _inputCommitments: _ic1,
          _authDigest: _ad1,
          ...circuitInputs1
        } = inputs1;
        const {
          _inputCommitments: _ic2,
          _authDigest: _ad2,
          ...circuitInputs2
        } = inputs2;

        const witness1 = await circuit.compute(circuitInputs1, [
          "nullifierHashes",
        ]);
        const witness2 = await circuit.compute(circuitInputs2, [
          "nullifierHashes",
        ]);

        const nullifiers1 = toArray(witness1.nullifierHashes);
        const nullifiers2 = toArray(witness2.nullifierHashes);

        // Different notes should produce different nullifiers
        expect(nullifiers1[0]).to.not.equal(nullifiers2[0]);
      });
    });

    describe("Value Conservation", () => {
      it("✨ should reject when outputs exceed inputs", async () => {
        const inputs = await createValidInputs({
          nInputs: 1,
          mOutputs: 2,
          inputValues: [1000n],
          inputLabels: [LABEL_A],
          outputValues: [800n, 400n], // Total = 1200 > 1000
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 0n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        // Expected failure: Global conservation (ValueConservation.circom line 67: totalIn === totalOut)
        const error = await circuit.expectFail(circuitInputs);
        expect(error).to.include("Assert Failed");
      });

      it("✨ should reject per-label value creation", async () => {
        // Input has LABEL_A, but outputs have LABEL_B (which has no input)
        const inputs = await createValidInputs({
          nInputs: 1,
          mOutputs: 2,
          inputValues: [1000n],
          inputLabels: [LABEL_A],
          outputValues: [500n, 500n],
          outputLabels: [LABEL_A, LABEL_B], // LABEL_B not in inputs
          amountOut: 0n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        // Expected failure: Per-label conservation (ValueConservation.circom line 114: conservationChecks[outIdx].out === 1)
        const error = await circuit.expectFail(circuitInputs);
        expect(error).to.include("Assert Failed");
      });
    });
  });

  // ============================================================================
  // TEST SUITE: Configuration (2, 2) - 2 inputs, 2 outputs
  // ============================================================================

  describe("Configuration: 2 inputs, 2 outputs", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_2_2", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          2,
          2,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    describe("Completeness - Valid Proofs", () => {
      it("✨ should accept valid 2-input transfer with same label", async () => {
        const inputs = await createValidInputs({
          nInputs: 2,
          mOutputs: 2,
          inputValues: [1000n, 500n],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [800n, 700n],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 0n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        const witness = await circuit.compute(circuitInputs, [
          "nullifierHashes",
          "outputCommitments",
        ]);

        const nullifierHashes = witness.nullifierHashes as bigint[];

        // Verify both nullifiers are computed
        expect(nullifierHashes.length).to.equal(2);

        // Verify nullifiers are unique
        expect(nullifierHashes[0]).to.not.equal(nullifierHashes[1]);
      });

      it("✨ should accept valid 2-input transfer with mixed labels", async () => {
        const inputs = await createValidInputs({
          nInputs: 2,
          mOutputs: 2,
          inputValues: [1000n, 500n],
          inputLabels: [LABEL_A, LABEL_B],
          outputValues: [800n, 400n],
          outputLabels: [LABEL_A, LABEL_B],
          amountOut: 300n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        await circuit.expectPass(circuitInputs);
      });

      it("✨ should accept withdrawal with partial value", async () => {
        const inputs = await createValidInputs({
          nInputs: 2,
          mOutputs: 2,
          inputValues: [1000n, 500n],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [500n, 200n],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 800n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        await circuit.expectPass(circuitInputs);
      });
    });

    describe("Non-Contiguous Note Positions", () => {
      it("✨ should accept transfer with non-contiguous notes in state tree", async () => {
        // Notes at indices 3 and 9 (with dummy leaves filling gaps)
        const inputs = await createValidInputs({
          nInputs: 2,
          mOutputs: 2,
          inputValues: [1000n, 500n],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [800n, 700n],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 0n,
          dummyLeavesBetween: [3, 5],
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        const witness = await circuit.compute(circuitInputs, [
          "nullifierHashes",
          "outputCommitments",
        ]);

        const nullifierHashes = witness.nullifierHashes as bigint[];
        expect(nullifierHashes.length).to.equal(2);
        expect(nullifierHashes[0]).to.not.equal(nullifierHashes[1]);

        // Verify nullifiers match TypeScript reference
        for (let i = 0; i < 2; i++) {
          const expected = await calculateNullifierHash(
            inputs.privateNullifyingKey,
            _inputCommitments[i],
          );
          expect(nullifierHashes[i]).to.equal(expected);
        }
      });

      it("✨ should accept withdrawal with non-contiguous notes", async () => {
        // Note 0 at index 0, note 1 at index 11 (large gap)
        const inputs = await createValidInputs({
          nInputs: 2,
          mOutputs: 2,
          inputValues: [1000n, 500n],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [500n, 200n],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 800n,
          dummyLeavesBetween: [0, 10],
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        await circuit.expectPass(circuitInputs);
      });

      it("✨ should accept mixed labels with non-contiguous notes", async () => {
        const inputs = await createValidInputs({
          nInputs: 2,
          mOutputs: 2,
          inputValues: [1000n, 500n],
          inputLabels: [LABEL_A, LABEL_B],
          outputValues: [800n, 400n],
          outputLabels: [LABEL_A, LABEL_B],
          amountOut: 300n,
          dummyLeavesBetween: [7, 12],
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        await circuit.expectPass(circuitInputs);
      });
    });

    describe("Per-Label Conservation", () => {
      it("✨ should reject cross-label value transfer", async () => {
        // Try to move value from LABEL_A to LABEL_B
        const inputs = await createValidInputs({
          nInputs: 2,
          mOutputs: 2,
          inputValues: [1000n, 500n],
          inputLabels: [LABEL_A, LABEL_B],
          outputValues: [500n, 1000n], // Moving 500 from A to B
          outputLabels: [LABEL_A, LABEL_B],
          amountOut: 0n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        // Expected failure: Per-label conservation (ValueConservation.circom line 114: conservationChecks[outIdx].out === 1)
        const error = await circuit.expectFail(circuitInputs);
        expect(error).to.include("Assert Failed");
      });
    });

    describe("Soundness - 2-Input Configuration", () => {
      it("✨ should reject when second input has wrong note secret", async () => {
        const inputs = await createValidInputs({
          nInputs: 2,
          mOutputs: 2,
          inputValues: [1000n, 500n],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [800n, 700n],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 0n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        // Corrupt second note secret
        circuitInputs.noteSecret[1] = randomFieldElement();

        // Expected failure: Commitment tree proof for second input (line 149)
        const error = await circuit.expectFail(circuitInputs);
        expect(error).to.include("Assert Failed");
      });

      it("✨ should reject when second input has wrong ASP proof", async () => {
        const inputs = await createValidInputs({
          nInputs: 2,
          mOutputs: 2,
          inputValues: [1000n, 500n],
          inputLabels: [LABEL_A, LABEL_B],
          outputValues: [800n, 400n],
          outputLabels: [LABEL_A, LABEL_B],
          amountOut: 300n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        // Corrupt second ASP siblings
        circuitInputs.associationSetSiblings[1][0] = randomFieldElement();

        // Expected failure: ASP proof for second input (line 167)
        const error = await circuit.expectFail(circuitInputs);
        expect(error).to.include("Assert Failed");
      });

      it("✨ should generate unique nullifiers for both inputs", async () => {
        const inputs = await createValidInputs({
          nInputs: 2,
          mOutputs: 2,
          inputValues: [1000n, 500n],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [800n, 700n],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 0n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        const witness = await circuit.compute(circuitInputs, [
          "nullifierHashes",
        ]);

        const nullifierHashes = witness.nullifierHashes as bigint[];

        // Both nullifiers must be different
        expect(nullifierHashes[0]).to.not.equal(nullifierHashes[1]);

        // Verify against TypeScript reference
        const expectedNullifier0 = await calculateNullifierHash(
          inputs.privateNullifyingKey,
          _inputCommitments[0],
        );
        const expectedNullifier1 = await calculateNullifierHash(
          inputs.privateNullifyingKey,
          _inputCommitments[1],
        );

        expect(nullifierHashes[0]).to.equal(expectedNullifier0);
        expect(nullifierHashes[1]).to.equal(expectedNullifier1);
      });
    });
  });

  // ============================================================================
  // TEST SUITE: Merkle Proof Verification
  // ============================================================================

  describe("Merkle Proof Verification", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      // Use 2x2 config to ensure multi-leaf trees (depth > 0) so tampering
      // siblings / indices actually causes constraint failures
      circuit = await circomkit.WitnessTester("Transact_2_2", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          2,
          2,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should reject tampered keystore siblings", async () => {
      const inputs = await createValidInputs({
        nInputs: 2,
        mOutputs: 2,
        inputValues: [1000n, 500n],
        inputLabels: [LABEL_A, LABEL_A],
        outputValues: [600n, 900n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Tamper with keystore siblings
      const tamperedSiblings = [...circuitInputs.keystoreSiblings];
      tamperedSiblings[0] = randomFieldElement();
      circuitInputs.keystoreSiblings = tamperedSiblings;

      // Expected failure: Keystore Merkle proof (Transact.circom line 97: authorizationProof.out === keystoreRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject tampered state tree siblings", async () => {
      const inputs = await createValidInputs({
        nInputs: 2,
        mOutputs: 2,
        inputValues: [1000n, 500n],
        inputLabels: [LABEL_A, LABEL_A],
        outputValues: [600n, 900n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Tamper with state tree siblings
      const tamperedSiblings = [...circuitInputs.stateSiblings[0]];
      tamperedSiblings[0] = randomFieldElement();
      circuitInputs.stateSiblings = [
        tamperedSiblings,
        circuitInputs.stateSiblings[1],
      ];

      // Expected failure: State Merkle proof (Transact.circom line 178: inputMerkleProofs[i].out === stateRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject tampered ASP siblings", async () => {
      const inputs = await createValidInputs({
        nInputs: 2,
        mOutputs: 2,
        inputValues: [1000n, 500n],
        inputLabels: [LABEL_A, LABEL_B],
        outputValues: [800n, 400n],
        outputLabels: [LABEL_A, LABEL_B],
        amountOut: 300n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Tamper with ASP siblings
      const tamperedSiblings = [...circuitInputs.associationSetSiblings[0]];
      tamperedSiblings[0] = randomFieldElement();
      circuitInputs.associationSetSiblings = [
        tamperedSiblings,
        circuitInputs.associationSetSiblings[1],
      ];

      // Expected failure: ASP Merkle proof (Transact.circom line 196: associationSetProofs[i].out === associationSetRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong keystore leaf index", async () => {
      const inputs = await createValidInputs({
        nInputs: 2,
        mOutputs: 2,
        inputValues: [1000n, 500n],
        inputLabels: [LABEL_A, LABEL_A],
        outputValues: [800n, 700n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Use wrong keystore leaf index
      circuitInputs.keystoreLeafIndex = circuitInputs.keystoreLeafIndex + 1n;

      // Expected failure: Keystore Merkle proof (Transact.circom line 97: authorizationProof.out === keystoreRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong state leaf index", async () => {
      const inputs = await createValidInputs({
        nInputs: 2,
        mOutputs: 2,
        inputValues: [1000n, 500n],
        inputLabels: [LABEL_A, LABEL_A],
        outputValues: [800n, 700n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Use wrong state leaf index for first input
      circuitInputs.stateLeafIndex = [
        circuitInputs.stateLeafIndex[0] + 1n,
        circuitInputs.stateLeafIndex[1],
      ];

      // Expected failure: State Merkle proof (Transact.circom line 178: inputMerkleProofs[i].out === stateRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong ASP leaf index", async () => {
      const inputs = await createValidInputs({
        nInputs: 2,
        mOutputs: 2,
        inputValues: [1000n, 500n],
        inputLabels: [LABEL_A, LABEL_B],
        outputValues: [800n, 400n],
        outputLabels: [LABEL_A, LABEL_B],
        amountOut: 300n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Use wrong ASP leaf index for first input
      circuitInputs.associationSetLeafIndex = [
        circuitInputs.associationSetLeafIndex[0] + 1n,
        circuitInputs.associationSetLeafIndex[1],
      ];

      // Expected failure: ASP Merkle proof (Transact.circom line 196: associationSetProofs[i].out === associationSetRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });
  });

  // ============================================================================
  // TEST SUITE: Soundness - Invalid Proofs
  // ============================================================================

  describe("Soundness - Invalid Proofs", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    // Shared test fixture - fresh copy created before each test
    let circuitInputs: Awaited<ReturnType<typeof createValidInputs>>;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_1_2", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          1,
          2,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    // Create fresh valid inputs before each soundness test
    beforeEach(async () => {
      circuitInputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [600n, 400n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });
    });

    it("✨ should reject invalid keystore proof", async () => {
      // Corrupt keystore root
      circuitInputs.keystoreRoot = randomFieldElement();

      // Expected failure: (line 109: keyProof.root === keystoreRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject invalid state tree proof", async () => {
      // Corrupt merkle root
      circuitInputs.stateRoot = randomFieldElement();

      // Expected failure: Commitment tree proof (line 149: inputMerkleProofs[i].root === stateRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject invalid ASP proof", async () => {
      // Corrupt ASP root
      circuitInputs.associationSetRoot = randomFieldElement();

      // Expected failure: ASP proof (line 167: associationSetProofs[i].root === associationSetRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong owner address", async () => {
      // Use wrong owner address
      circuitInputs.ownerAddress = randomFieldElement();

      // Expected failure: Keystore leaf mismatch (line 109: keyProof.root === keystoreRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong private nullifying key", async () => {
      // Use wrong nullifying key
      circuitInputs.privateNullifyingKey = randomFieldElement();

      // Expected failure: Keystore leaf mismatch (line 109: keyProof.root === keystoreRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject token mismatch (tokenId != tokenIdOut) on withdrawal", async () => {
      // Token check only applies for withdrawals (amountOut > 0)
      // Set up a withdrawal scenario first
      circuitInputs.amountOut = 100n;
      // Use different tokenIdOut than tokenId
      circuitInputs.tokenIdOut = randomTokenId();

      // Expected failure: Token mismatch (line 204: (tokenId - tokenIdOut) * (1 - amountOutIsZero.out) === 0)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should accept tokenIdOut != tokenId on pure internal transfer (amountOut == 0)", async () => {
      // The `(tokenId - tokenIdOut) * (1 - amountOutIsZero.out) === 0`
      // constraint is relaxed when amountOut == 0, so tokenIdOut may carry
      // any value within the 160-bit range. This documents the allowed
      // flexibility and serves as a regression guard: if the constraint is
      // ever strengthened to require tokenId == tokenIdOut unconditionally,
      // this test will start failing.
      circuitInputs.tokenIdOut = randomTokenId();
      // amountOut stays at baseline (0); no withdrawal scenario.
      const { _inputCommitments, _authDigest, ...inputs } = circuitInputs;
      await circuit.expectPass(inputs);
    });

    it("✨ should reject wrong private revocable key", async () => {
      // Use wrong revocable key (changes authDigest, fails keystore proof)
      circuitInputs.privateRevocableKey = randomFieldElement();

      // Expected failure: Keystore proof (line 109: keyProof.root === keystoreRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong note secret", async () => {
      // Use wrong note secret (changes noteAddressHash, fails commitment reconstruction)
      circuitInputs.noteSecret = [randomFieldElement()];

      // Expected failure: Commitment tree proof (line 149: inputMerkleProofs[i].root === stateRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong input label", async () => {
      // Use wrong label (changes commitment, fails commitment reconstruction)
      circuitInputs.label = [randomFieldElement()];

      // Expected failure: Commitment tree proof (line 149: inputMerkleProofs[i].root === stateRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong input value", async () => {
      // Use wrong value (changes commitment, fails commitment reconstruction)
      circuitInputs.value = [500n];

      // Expected failure: Commitment tree proof (line 149: inputMerkleProofs[i].root === stateRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject keystoreTreeDepth > keystoreMaxDepth", async () => {
      // BinaryMerkleRoot outputs 0 for depth > MAX_DEPTH, which could be exploited
      // The circuit must validate depth <= maxDepth
      circuitInputs.keystoreTreeDepth = BigInt(KEYSTORE_MAX_DEPTH + 1);

      // Expected failure: Transact.circom line 104 (keystoreDepthCheck.out === 1)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject stateTreeDepth > stateMaxDepth", async () => {
      // BinaryMerkleRoot outputs 0 for depth > MAX_DEPTH, which could be exploited
      circuitInputs.stateTreeDepth = [BigInt(STATE_MAX_DEPTH + 1)];

      // Expected failure: Transact.circom (stateDepthCheck[0].out === 1)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject associationSetTreeDepth > associationSetMaxDepth", async () => {
      // BinaryMerkleRoot outputs 0 for depth > MAX_DEPTH, which could be exploited
      circuitInputs.associationSetTreeDepth = [
        BigInt(ASSOCIATION_SET_MAX_DEPTH + 1),
      ];

      // Expected failure: Transact.circom (associationSetDepthCheck[0].out === 1)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject field-wrapped keystoreTreeDepth (p-1 attack)", async () => {
      const BN128_PRIME_MINUS_1 =
        21888242871839275222246405745257275088548364400416034343698204186575808495616n;
      circuitInputs.keystoreTreeDepth = BN128_PRIME_MINUS_1;

      // Expected failure: Transact.circom (keystoreDepthRange - Num2Bits fails)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject field-wrapped stateTreeDepth (p-1 attack)", async () => {
      const BN128_PRIME_MINUS_1 =
        21888242871839275222246405745257275088548364400416034343698204186575808495616n;
      circuitInputs.stateTreeDepth = [BN128_PRIME_MINUS_1];

      // Expected failure: Transact.circom (stateDepthRange[0] - Num2Bits fails)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject field-wrapped associationSetTreeDepth (p-1 attack)", async () => {
      const BN128_PRIME_MINUS_1 =
        21888242871839275222246405745257275088548364400416034343698204186575808495616n;
      circuitInputs.associationSetTreeDepth = [BN128_PRIME_MINUS_1];

      // Expected failure: Transact.circom (associationSetDepthRange[0] - Num2Bits fails)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject when timestamp does not match state tree", async () => {
      // Corrupt timestamp - this should cause Merkle proof failure since
      // the leaf is hash(commitment, timestamp)
      circuitInputs.timestamp = [randomFieldElement()];

      // Expected failure: State tree Merkle proof (line 163: inputMerkleProofs[i].out === stateRoot)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });
  });

  // ============================================================================
  // TEST SUITE: Context Binding
  // ============================================================================

  describe("Context Binding", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_1_2", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          1,
          2,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should accept any context value (binding constraint)", async () => {
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [600n, 400n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Context is a commitment to withdrawal details - circuit just binds it
      circuitInputs.context = randomFieldElement();
      await circuit.expectPass(circuitInputs);

      // Different context also works
      circuitInputs.context = 0n;
      await circuit.expectPass(circuitInputs);

      // Max field element as context
      circuitInputs.context =
        21888242871839275222246405745257275088548364400416034343698204186575808495616n;
      await circuit.expectPass(circuitInputs);
    });

    it("✨ should produce same outputs regardless of context", async () => {
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [600n, 400n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Compute with context A
      circuitInputs.context = 12345n;
      const witnessA = await circuit.compute(circuitInputs, [
        "nullifierHashes",
        "outputCommitments",
      ]);

      // Compute with context B
      circuitInputs.context = 67890n;
      const witnessB = await circuit.compute(circuitInputs, [
        "nullifierHashes",
        "outputCommitments",
      ]);

      // Nullifiers and commitments should be the same (context doesn't affect them)
      const nullifiersA = toArray(witnessA.nullifierHashes);
      const nullifiersB = toArray(witnessB.nullifierHashes);
      expect(nullifiersA[0]).to.equal(nullifiersB[0]);

      const commitmentsA = witnessA.outputCommitments as bigint[];
      const commitmentsB = witnessB.outputCommitments as bigint[];
      expect(commitmentsA[0]).to.equal(commitmentsB[0]);
      expect(commitmentsA[1]).to.equal(commitmentsB[1]);
    });
  });

  // ============================================================================
  // TEST SUITE: TypeScript Reference Validation
  // ============================================================================

  describe("TypeScript Reference Validation", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_1_2", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          1,
          2,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should match TypeScript nullifier computation", async () => {
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [600n, 400n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      const witness = await circuit.compute(circuitInputs, ["nullifierHashes"]);

      const nullifierHashes = toArray(witness.nullifierHashes);

      // Compute expected nullifier using reference
      const expectedNullifier = await calculateNullifierHash(
        inputs.privateNullifyingKey,
        _inputCommitments[0],
      );

      expect(nullifierHashes[0]).to.equal(expectedNullifier);
    });

    it("✨ should match TypeScript output commitment computation", async () => {
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [600n, 400n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      const witness = await circuit.compute(circuitInputs, [
        "outputCommitments",
      ]);

      const outputCommitments = witness.outputCommitments as bigint[];

      // Compute expected commitments using reference
      for (let j = 0; j < 2; j++) {
        const expectedCommitment = await calculateNoteCommitment(
          inputs.outputNoteAddressHash[j],
          inputs.tokenId,
          inputs.outputValue[j],
          EMPTY_METADATA,
          inputs.outputLabel[j],
        );
        expect(outputCommitments[j]).to.equal(expectedCommitment);
      }
    });
  });

  // ============================================================================
  // TEST SUITE: Boundary Cases
  // ============================================================================

  describe("Boundary Cases", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    const MAX_128_BIT = 2n ** 128n - 1n;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_1_2", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          1,
          2,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should accept maximum 128-bit input value", async () => {
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [MAX_128_BIT],
        inputLabels: [LABEL_A],
        outputValues: [MAX_128_BIT - 100n, 100n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      await circuit.expectPass(circuitInputs);
    });

    it("✨ should accept maximum 128-bit output value", async () => {
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [MAX_128_BIT],
        inputLabels: [LABEL_A],
        outputValues: [MAX_128_BIT, 0n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      await circuit.expectPass(circuitInputs);
    });

    it("✨ should accept zero input value", async () => {
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [0n],
        inputLabels: [LABEL_A],
        outputValues: [0n, 0n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      await circuit.expectPass(circuitInputs);
    });

    it("✨ should accept full withdrawal (all value withdrawn)", async () => {
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [0n, 0n], // All withdrawn
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 1000n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      await circuit.expectPass(circuitInputs);
    });

    it("✨ should accept maximum 128-bit withdrawal amount", async () => {
      const MAX_128_BIT = 2n ** 128n - 1n;
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [MAX_128_BIT],
        inputLabels: [LABEL_A],
        outputValues: [0n, 0n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: MAX_128_BIT,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      await circuit.expectPass(circuitInputs);
    });
  });

  // ============================================================================
  // TEST SUITE: Value Range Checks
  // ============================================================================

  describe("Value Range Checks", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    const OVERFLOW_VALUE = 2n ** 128n; // Exactly 2^128 - should fail

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_1_2", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          1,
          2,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should reject input value >= 2^128", async () => {
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [OVERFLOW_VALUE],
        inputLabels: [LABEL_A],
        outputValues: [1000n, 0n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Expected failure: Input value range check (line 125: valueRangeChecks[i].in <== value[i])
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject output value >= 2^128", async () => {
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [OVERFLOW_VALUE, 0n], // Output exceeds 128 bits
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Expected failure: Output value range check (line 188: outputValueRangeChecks[j].in <== outputValue[j])
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });
  });

  // ============================================================================
  // TEST SUITE: Token ID Range Check (INS-1)
  // ============================================================================
  // tokenId and tokenIdOut represent EVM addresses (160 bits) onchain. The
  // in-circuit Num2Bits(160) keeps the proof-side canonical value aligned with
  // the contract-side lower-160-bit cast.

  describe("Token ID Range Check (INS-1)", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    const TWO_160 = 1n << 160n;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_1_2", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          1,
          2,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should reject tokenId at 2^160", async () => {
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [1000n, 0n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });
      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;
      circuitInputs.tokenId = TWO_160;
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.exist;
    });

    it("✨ should reject tokenIdOut at 2^160", async () => {
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [1000n, 0n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });
      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;
      circuitInputs.tokenIdOut = TWO_160;
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.exist;
    });
  });

  // ============================================================================
  // TEST SUITE: Non-Contiguous Note Positions (multi-config)
  // ============================================================================
  // In production, a user's notes are interleaved with other users' notes at
  // non-contiguous positions in the state tree. These tests verify correct
  // behavior with variable proof depths and independent Merkle paths.

  describe("Non-Contiguous Note Positions (multi-config)", () => {
    const NONCONTIG_CONFIGS: Array<{
      nInputs: number;
      mOutputs: number;
      dummyLeavesBetween: number[];
      description: string;
    }> = [
      {
        nInputs: 2,
        mOutputs: 3,
        dummyLeavesBetween: [5, 8],
        description: "2x3: notes at indices 5 and 14",
      },
      {
        nInputs: 3,
        mOutputs: 3,
        dummyLeavesBetween: [4, 7, 3],
        description: "3x3: notes at indices 4, 12, and 16",
      },
      {
        nInputs: 3,
        mOutputs: 4,
        dummyLeavesBetween: [0, 15, 10],
        description: "3x4: notes at indices 0, 16, and 27",
      },
      {
        nInputs: 4,
        mOutputs: 3,
        dummyLeavesBetween: [2, 6, 0, 11],
        description: "4x3: notes at indices 2, 9, 10, and 22",
      },
      {
        nInputs: 5,
        mOutputs: 5,
        dummyLeavesBetween: [3, 8, 1, 12, 5],
        description: "5x5: notes at indices 3, 12, 14, 27, and 33",
      },
    ];

    for (const cfg of NONCONTIG_CONFIGS) {
      describe(`Configuration: ${cfg.description}`, () => {
        let circuit: WitnessTester<
          [
            "stateRoot",
            "keystoreRoot",
            "associationSetRoot",
            "amountOut",
            "tokenIdOut",
            "context",
            "ownerAddress",
            "privateNullifyingKey",
            "privateRevocableKey",
            "keystoreLeafIndex",
            "keystoreSiblings",
            "keystoreTreeDepth",
            "noteSecret",
            "value",
            "tokenId",
            "label",
            "stateLeafIndex",
            "stateSiblings",
            "stateTreeDepth",
            "associationSetLeafIndex",
            "associationSetSiblings",
            "associationSetTreeDepth",
            "timestamp",
            "outputNoteAddressHash",
            "outputValue",
            "outputLabel",
          ],
          ["nullifierHashes", "outputCommitments"]
        >;

        before(async () => {
          circuit = await circomkit.WitnessTester(
            `Transact_${cfg.nInputs}_${cfg.mOutputs}`,
            {
              file: "templates/Transact",
              template: "Transact",
              params: [
                cfg.nInputs,
                cfg.mOutputs,
                STATE_MAX_DEPTH,
                KEYSTORE_MAX_DEPTH,
                ASSOCIATION_SET_MAX_DEPTH,
              ],
              dir: "test/main",
            },
          );
        });

        it(`✨ should accept transfer with non-contiguous notes`, async () => {
          const totalValue = 10000n;
          const inputValues: bigint[] = [];
          const inputLabels: bigint[] = [];
          let remaining = totalValue;

          for (let i = 0; i < cfg.nInputs; i++) {
            if (i === cfg.nInputs - 1) {
              inputValues.push(remaining);
            } else {
              const val = totalValue / BigInt(cfg.nInputs);
              inputValues.push(val);
              remaining -= val;
            }
            inputLabels.push(LABEL_A);
          }

          const outputValues: bigint[] = [];
          const outputLabels: bigint[] = [];
          let remainingOut = totalValue;

          for (let j = 0; j < cfg.mOutputs; j++) {
            if (j === cfg.mOutputs - 1) {
              outputValues.push(remainingOut);
            } else {
              const val = totalValue / BigInt(cfg.mOutputs);
              outputValues.push(val);
              remainingOut -= val;
            }
            outputLabels.push(LABEL_A);
          }

          const inputs = await createValidInputs({
            nInputs: cfg.nInputs,
            mOutputs: cfg.mOutputs,
            inputValues,
            inputLabels,
            outputValues,
            outputLabels,
            amountOut: 0n,
            dummyLeavesBetween: cfg.dummyLeavesBetween,
          });

          const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

          const witness = await circuit.compute(circuitInputs, [
            "nullifierHashes",
            "outputCommitments",
          ]);

          const nullifierHashes = toArray(witness.nullifierHashes);

          // Verify all nullifiers match TypeScript reference
          for (let i = 0; i < cfg.nInputs; i++) {
            const expected = await calculateNullifierHash(
              inputs.privateNullifyingKey,
              _inputCommitments[i],
            );
            expect(nullifierHashes[i]).to.equal(expected);
          }
        });

        it(`✨ should accept withdrawal with non-contiguous notes`, async () => {
          const totalValue = 10000n;
          const withdrawAmount = 1000n;
          const remainingValue = totalValue - withdrawAmount;

          const inputValues: bigint[] = [];
          const inputLabels: bigint[] = [];
          let remaining = totalValue;

          for (let i = 0; i < cfg.nInputs; i++) {
            if (i === cfg.nInputs - 1) {
              inputValues.push(remaining);
            } else {
              const val = totalValue / BigInt(cfg.nInputs);
              inputValues.push(val);
              remaining -= val;
            }
            inputLabels.push(LABEL_A);
          }

          const outputValues: bigint[] = [];
          const outputLabels: bigint[] = [];
          let remainingOut = remainingValue;

          for (let j = 0; j < cfg.mOutputs; j++) {
            if (j === cfg.mOutputs - 1) {
              outputValues.push(remainingOut);
            } else {
              const val = remainingValue / BigInt(cfg.mOutputs);
              outputValues.push(val);
              remainingOut -= val;
            }
            outputLabels.push(LABEL_A);
          }

          const inputs = await createValidInputs({
            nInputs: cfg.nInputs,
            mOutputs: cfg.mOutputs,
            inputValues,
            inputLabels,
            outputValues,
            outputLabels,
            amountOut: withdrawAmount,
            dummyLeavesBetween: cfg.dummyLeavesBetween,
          });

          const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

          await circuit.expectPass(circuitInputs);
        });

        it(`✨ should accept mixed labels with non-contiguous notes`, async () => {
          const inputValues: bigint[] = [];
          const inputLabels: bigint[] = [];
          const outputValues: bigint[] = [];
          const outputLabels: bigint[] = [];

          // Alternate labels across inputs
          let totalPerLabel: Record<string, bigint> = {};
          for (let i = 0; i < cfg.nInputs; i++) {
            const label = i % 2 === 0 ? LABEL_A : LABEL_B;
            const val = BigInt(1000 * (i + 1));
            inputValues.push(val);
            inputLabels.push(label);
            const key = label.toString();
            totalPerLabel[key] = (totalPerLabel[key] || 0n) + val;
          }

          // Distribute outputs respecting per-label conservation
          const labelsUsed = Object.keys(totalPerLabel);
          let labelIdx = 0;
          for (const key of labelsUsed) {
            const label = BigInt(key);
            const total = totalPerLabel[key];
            const isLastLabel = labelIdx === labelsUsed.length - 1;
            const outputsForLabel = isLastLabel
              ? cfg.mOutputs - outputValues.length
              : Math.max(1, Math.floor(cfg.mOutputs / labelsUsed.length));

            let rem = total;
            for (let j = 0; j < outputsForLabel; j++) {
              if (j === outputsForLabel - 1) {
                outputValues.push(rem);
              } else {
                const val = total / BigInt(outputsForLabel);
                outputValues.push(val);
                rem -= val;
              }
              outputLabels.push(label);
            }
            labelIdx++;
          }

          // Pad remaining outputs with zero-value if needed
          while (outputValues.length < cfg.mOutputs) {
            outputValues.push(0n);
            outputLabels.push(LABEL_A);
          }

          const inputs = await createValidInputs({
            nInputs: cfg.nInputs,
            mOutputs: cfg.mOutputs,
            inputValues,
            inputLabels,
            outputValues,
            outputLabels,
            amountOut: 0n,
            dummyLeavesBetween: cfg.dummyLeavesBetween,
          });

          const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

          await circuit.expectPass(circuitInputs);
        });
      });
    }
  });

  // ============================================================================
  // TEST SUITE: Fuzzing
  // ============================================================================

  describe("Fuzzing", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_1_2", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          1,
          2,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should handle 20 random valid transactions", async () => {
      for (let i = 0; i < 20; i++) {
        const inputValue = randomValue();
        // Ensure outputs sum to input (valid conservation)
        const outputValue1 = inputValue / 2n;
        const outputValue2 = inputValue - outputValue1;

        const inputs = await createValidInputs({
          nInputs: 1,
          mOutputs: 2,
          inputValues: [inputValue],
          inputLabels: [LABEL_A],
          outputValues: [outputValue1, outputValue2],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 0n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        await circuit.expectPass(circuitInputs);
      }
    });

    it("✨ should maintain nullifier uniqueness across 20 random transactions", async () => {
      const nullifiers = new Set<string>();

      for (let i = 0; i < 20; i++) {
        const inputValue = randomValue();
        const outputValue1 = inputValue / 2n;
        const outputValue2 = inputValue - outputValue1;

        const inputs = await createValidInputs({
          nInputs: 1,
          mOutputs: 2,
          inputValues: [inputValue],
          inputLabels: [LABEL_A],
          outputValues: [outputValue1, outputValue2],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 0n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        const witness = await circuit.compute(circuitInputs, [
          "nullifierHashes",
        ]);

        const nullifierHashes = toArray(witness.nullifierHashes);
        nullifiers.add(nullifierHashes[0].toString());
      }

      // All 20 nullifiers should be unique
      expect(nullifiers.size).to.equal(20);
    });

    it("✨ should handle random withdrawal amounts", async () => {
      for (let i = 0; i < 10; i++) {
        const inputValue = randomValue();
        // Random withdrawal between 0 and inputValue
        const withdrawAmount =
          inputValue > 0n
            ? BigInt(Math.floor(Math.random() * Number(inputValue % 1000000n)))
            : 0n;
        const remainingValue = inputValue - withdrawAmount;
        const outputValue1 = remainingValue / 2n;
        const outputValue2 = remainingValue - outputValue1;

        const inputs = await createValidInputs({
          nInputs: 1,
          mOutputs: 2,
          inputValues: [inputValue],
          inputLabels: [LABEL_A],
          outputValues: [outputValue1, outputValue2],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: withdrawAmount,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        await circuit.expectPass(circuitInputs);
      }
    });
  });

  // ============================================================================
  // TEST SUITE: Variable Depth Proofs (Regression)
  // ============================================================================
  // This suite explicitly verifies that per-input depth works.
  // With non-power-of-2 leaf counts, LeanIMT produces proofs of different
  // depths for different leaves.

  describe("Variable Depth Proofs (Regression)", () => {
    let circuit3x3: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    let circuit5x5: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      circuit3x3 = await circomkit.WitnessTester("Transact_3_3", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          3,
          3,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
      circuit5x5 = await circomkit.WitnessTester("Transact_5_5", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          5,
          5,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ 3x3: should accept inputs with different state tree proof depths", async () => {
      // 3 leaves in LeanIMT: indices 0,1 get depth 2, index 2 gets depth 1
      const inputs = await createValidInputs({
        nInputs: 3,
        mOutputs: 3,
        inputValues: [1000n, 2000n, 3000n],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A],
        outputValues: [2000n, 2000n, 2000n],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Verify depths are actually different (the regression condition)
      const depths = circuitInputs.stateTreeDepth as bigint[];
      const hasVariableDepths = !depths.every((d) => d === depths[0]);
      expect(hasVariableDepths).to.equal(
        true,
        "Expected variable proof depths for 3-leaf LeanIMT",
      );

      await circuit3x3.expectPass(circuitInputs);
    });

    it("✨ 5x5: should accept inputs with different state tree proof depths", async () => {
      // 5 leaves in LeanIMT: indices 0-3 get depth 3, index 4 gets depth 1
      const inputs = await createValidInputs({
        nInputs: 5,
        mOutputs: 5,
        inputValues: [1000n, 1000n, 1000n, 1000n, 1000n],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        outputValues: [1000n, 1000n, 1000n, 1000n, 1000n],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Verify depths are actually different (the regression condition)
      const depths = circuitInputs.stateTreeDepth as bigint[];
      const hasVariableDepths = !depths.every((d) => d === depths[0]);
      expect(hasVariableDepths).to.equal(
        true,
        "Expected variable proof depths for 5-leaf LeanIMT",
      );

      await circuit5x5.expectPass(circuitInputs);
    });

    it("✨ 3x3: should accept inputs with different ASP tree proof depths", async () => {
      // 3 unique labels -> 3 leaves in ASP tree -> variable depths
      const inputs = await createValidInputs({
        nInputs: 3,
        mOutputs: 3,
        inputValues: [1000n, 2000n, 3000n],
        inputLabels: [LABEL_A, LABEL_B, LABEL_C],
        outputValues: [1000n, 2000n, 3000n],
        outputLabels: [LABEL_A, LABEL_B, LABEL_C],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Verify ASP depths are actually different
      const aspDepths = circuitInputs.associationSetTreeDepth as bigint[];
      const hasVariableDepths = !aspDepths.every((d) => d === aspDepths[0]);
      expect(hasVariableDepths).to.equal(
        true,
        "Expected variable ASP proof depths for 3-leaf LeanIMT",
      );

      await circuit3x3.expectPass(circuitInputs);
    });
  });

  // ============================================================================
  // TEST SUITE: Soundness - 3x3 Configuration
  // ============================================================================

  describe("Soundness - 3x3 Configuration", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_3_3", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          3,
          3,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should reject wrong note secret on 3rd input", async () => {
      const inputs = await createValidInputs({
        nInputs: 3,
        mOutputs: 3,
        inputValues: [1000n, 2000n, 3000n],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A],
        outputValues: [2000n, 2000n, 2000n],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Corrupt 3rd input's note secret
      circuitInputs.noteSecret[2] = randomFieldElement();

      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong Merkle proof on 3rd input", async () => {
      const inputs = await createValidInputs({
        nInputs: 3,
        mOutputs: 3,
        inputValues: [1000n, 2000n, 3000n],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A],
        outputValues: [2000n, 2000n, 2000n],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Corrupt 3rd input's state siblings
      circuitInputs.stateSiblings[2][0] = randomFieldElement();

      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject per-label conservation with 3 labels", async () => {
      // Input: A=1000, B=2000, C=3000
      // Output: try to move value from C to A (A=2000, B=2000, C=2000)
      // Per-label: A has 1000 in but 2000 out → should fail
      const inputs = await createValidInputs({
        nInputs: 3,
        mOutputs: 3,
        inputValues: [1000n, 2000n, 3000n],
        inputLabels: [LABEL_A, LABEL_B, LABEL_C],
        outputValues: [2000n, 2000n, 2000n],
        outputLabels: [LABEL_A, LABEL_B, LABEL_C],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should generate unique nullifiers across 3 inputs", async () => {
      const inputs = await createValidInputs({
        nInputs: 3,
        mOutputs: 3,
        inputValues: [1000n, 2000n, 3000n],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A],
        outputValues: [2000n, 2000n, 2000n],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      const witness = await circuit.compute(circuitInputs, ["nullifierHashes"]);
      const nullifierHashes = witness.nullifierHashes as bigint[];

      expect(nullifierHashes.length).to.equal(3);

      // All 3 nullifiers must be distinct
      const uniqueNullifiers = new Set(
        nullifierHashes.map((n) => n.toString()),
      );
      expect(uniqueNullifiers.size).to.equal(3);

      // Verify against TypeScript reference
      for (let i = 0; i < 3; i++) {
        const expected = await calculateNullifierHash(
          inputs.privateNullifyingKey,
          _inputCommitments[i],
        );
        expect(nullifierHashes[i]).to.equal(expected);
      }
    });

    it("✨ should reject wrong ASP proof on 3rd input", async () => {
      const inputs = await createValidInputs({
        nInputs: 3,
        mOutputs: 3,
        inputValues: [1000n, 2000n, 3000n],
        inputLabels: [LABEL_A, LABEL_B, LABEL_C],
        outputValues: [1000n, 2000n, 3000n],
        outputLabels: [LABEL_A, LABEL_B, LABEL_C],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Corrupt 3rd input's ASP siblings
      circuitInputs.associationSetSiblings[2][0] = randomFieldElement();

      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });
  });

  // ============================================================================
  // TEST SUITE: Soundness - 5x5 Configuration
  // ============================================================================

  describe("Soundness - 5x5 Configuration", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_5_5", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          5,
          5,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should reject wrong note secret on 5th input", async () => {
      const inputs = await createValidInputs({
        nInputs: 5,
        mOutputs: 5,
        inputValues: [1000n, 1000n, 1000n, 1000n, 1000n],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        outputValues: [1000n, 1000n, 1000n, 1000n, 1000n],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Corrupt 5th input's note secret
      circuitInputs.noteSecret[4] = randomFieldElement();

      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong Merkle proof on 5th input", async () => {
      const inputs = await createValidInputs({
        nInputs: 5,
        mOutputs: 5,
        inputValues: [1000n, 1000n, 1000n, 1000n, 1000n],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        outputValues: [1000n, 1000n, 1000n, 1000n, 1000n],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Corrupt 5th input's state siblings
      circuitInputs.stateSiblings[4][0] = randomFieldElement();

      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong ASP proof on 5th input", async () => {
      const LABEL_D = 4n;
      const LABEL_E = 5n;
      const inputs = await createValidInputs({
        nInputs: 5,
        mOutputs: 5,
        inputValues: [1000n, 1000n, 1000n, 1000n, 1000n],
        inputLabels: [LABEL_A, LABEL_B, LABEL_C, LABEL_D, LABEL_E],
        outputValues: [1000n, 1000n, 1000n, 1000n, 1000n],
        outputLabels: [LABEL_A, LABEL_B, LABEL_C, LABEL_D, LABEL_E],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      circuitInputs.associationSetSiblings[4][0] = randomFieldElement();

      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject per-label conservation with 5 labels", async () => {
      const LABEL_D = 4n;
      const LABEL_E = 5n;
      // Try moving value from E to A
      const inputs = await createValidInputs({
        nInputs: 5,
        mOutputs: 5,
        inputValues: [500n, 500n, 500n, 500n, 500n],
        inputLabels: [LABEL_A, LABEL_B, LABEL_C, LABEL_D, LABEL_E],
        outputValues: [800n, 500n, 500n, 500n, 200n],
        outputLabels: [LABEL_A, LABEL_B, LABEL_C, LABEL_D, LABEL_E],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Label A: input = 500, output = 800 (FAIL: 500 < 800)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should generate unique nullifiers across 5 inputs", async () => {
      const inputs = await createValidInputs({
        nInputs: 5,
        mOutputs: 5,
        inputValues: [1000n, 2000n, 3000n, 4000n, 5000n],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        outputValues: [3000n, 3000n, 3000n, 3000n, 3000n],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      const witness = await circuit.compute(circuitInputs, ["nullifierHashes"]);
      const nullifierHashes = witness.nullifierHashes as bigint[];

      expect(nullifierHashes.length).to.equal(5);

      const uniqueNullifiers = new Set(
        nullifierHashes.map((n) => n.toString()),
      );
      expect(uniqueNullifiers.size).to.equal(5);
    });
  });

  // ============================================================================
  // TEST SUITE: Soundness - 4x4 Configuration
  // ============================================================================

  describe("Soundness - 4x4 Configuration", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_4_4", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          4,
          4,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should reject wrong note secret on 4th input", async () => {
      const inputs = await createValidInputs({
        nInputs: 4,
        mOutputs: 4,
        inputValues: [1000n, 1000n, 1000n, 1000n],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        outputValues: [1000n, 1000n, 1000n, 1000n],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      circuitInputs.noteSecret[3] = randomFieldElement();

      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong Merkle proof on 4th input", async () => {
      const inputs = await createValidInputs({
        nInputs: 4,
        mOutputs: 4,
        inputValues: [1000n, 1000n, 1000n, 1000n],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        outputValues: [1000n, 1000n, 1000n, 1000n],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      circuitInputs.stateSiblings[3][0] = randomFieldElement();

      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong ASP proof on 4th input", async () => {
      const LABEL_D = 4n;
      const inputs = await createValidInputs({
        nInputs: 4,
        mOutputs: 4,
        inputValues: [1000n, 1000n, 1000n, 1000n],
        inputLabels: [LABEL_A, LABEL_B, LABEL_C, LABEL_D],
        outputValues: [1000n, 1000n, 1000n, 1000n],
        outputLabels: [LABEL_A, LABEL_B, LABEL_C, LABEL_D],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      circuitInputs.associationSetSiblings[3][0] = randomFieldElement();

      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject per-label conservation with 4 labels", async () => {
      const LABEL_D = 4n;
      // Try moving value from D to A
      const inputs = await createValidInputs({
        nInputs: 4,
        mOutputs: 4,
        inputValues: [500n, 500n, 500n, 500n],
        inputLabels: [LABEL_A, LABEL_B, LABEL_C, LABEL_D],
        outputValues: [800n, 500n, 500n, 200n],
        outputLabels: [LABEL_A, LABEL_B, LABEL_C, LABEL_D],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Label A: input = 500, output = 800 (FAIL: 500 < 800)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should generate unique nullifiers across 4 inputs", async () => {
      const inputs = await createValidInputs({
        nInputs: 4,
        mOutputs: 4,
        inputValues: [1000n, 2000n, 3000n, 4000n],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        outputValues: [2500n, 2500n, 2500n, 2500n],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      const witness = await circuit.compute(circuitInputs, ["nullifierHashes"]);
      const nullifierHashes = witness.nullifierHashes as bigint[];

      expect(nullifierHashes.length).to.equal(4);

      const uniqueNullifiers = new Set(
        nullifierHashes.map((n) => n.toString()),
      );
      expect(uniqueNullifiers.size).to.equal(4);

      for (let i = 0; i < 4; i++) {
        const expected = await calculateNullifierHash(
          inputs.privateNullifyingKey,
          _inputCommitments[i],
        );
        expect(nullifierHashes[i]).to.equal(expected);
      }
    });
  });

  // ============================================================================
  // TEST SUITE: Soundness - NxM where N!=M (3x2)
  // ============================================================================

  describe("Soundness - 3x2 Configuration (N!=M)", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_3_2", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          3,
          2,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should reject wrong note secret on 3rd input (N>M config)", async () => {
      const inputs = await createValidInputs({
        nInputs: 3,
        mOutputs: 2,
        inputValues: [1000n, 1000n, 1000n],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A],
        outputValues: [1500n, 1500n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      circuitInputs.noteSecret[2] = randomFieldElement();

      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject per-label conservation violation (N>M config)", async () => {
      // 3 inputs with mixed labels, 2 outputs — try cross-label transfer
      const inputs = await createValidInputs({
        nInputs: 3,
        mOutputs: 2,
        inputValues: [1000n, 500n, 500n],
        inputLabels: [LABEL_A, LABEL_B, LABEL_A],
        outputValues: [1000n, 1000n],
        outputLabels: [LABEL_A, LABEL_B],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Label B: input = 500, output = 1000 (FAIL)
      const error = await circuit.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should accept valid consolidation (3 inputs → 2 outputs)", async () => {
      const inputs = await createValidInputs({
        nInputs: 3,
        mOutputs: 2,
        inputValues: [1000n, 500n, 500n],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A],
        outputValues: [1200n, 800n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      await circuit.expectPass(circuitInputs);
    });
  });

  // ============================================================================
  // TEST SUITE: Fuzzing (2x2)
  // ============================================================================

  describe("Fuzzing (2x2)", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_2_2", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          2,
          2,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should handle 10 random valid 2x2 transactions", async () => {
      for (let i = 0; i < 10; i++) {
        const inputValue1 = randomValue();
        const inputValue2 = randomValue();
        const total = inputValue1 + inputValue2;
        const outputValue1 = total / 2n;
        const outputValue2 = total - outputValue1;

        const inputs = await createValidInputs({
          nInputs: 2,
          mOutputs: 2,
          inputValues: [inputValue1, inputValue2],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [outputValue1, outputValue2],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: 0n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        await circuit.expectPass(circuitInputs);
      }
    });

    it("✨ should handle 10 random valid 2x2 mixed-label transactions", async () => {
      for (let i = 0; i < 10; i++) {
        const valueA = randomValue();
        const valueB = randomValue();
        // Ensure per-label conservation: outputs for each label <= inputs for that label
        const outputA = valueA / 2n;
        const outputB = valueB / 2n;
        const withdrawAmount = valueA - outputA + (valueB - outputB);

        const inputs = await createValidInputs({
          nInputs: 2,
          mOutputs: 2,
          inputValues: [valueA, valueB],
          inputLabels: [LABEL_A, LABEL_B],
          outputValues: [outputA, outputB],
          outputLabels: [LABEL_A, LABEL_B],
          amountOut: withdrawAmount,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        await circuit.expectPass(circuitInputs);
      }
    });
  });

  // ============================================================================
  // TEST SUITE: Fuzzing (3x3)
  // ============================================================================

  describe("Fuzzing (3x3)", () => {
    let circuit: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("Transact_3_3", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          3,
          3,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should handle 10 random valid 3x3 transactions", async () => {
      for (let i = 0; i < 10; i++) {
        const inputValue1 = randomValue();
        const inputValue2 = randomValue();
        const inputValue3 = randomValue();
        const total = inputValue1 + inputValue2 + inputValue3;
        const out1 = total / 3n;
        const out2 = total / 3n;
        const out3 = total - out1 - out2;

        const inputs = await createValidInputs({
          nInputs: 3,
          mOutputs: 3,
          inputValues: [inputValue1, inputValue2, inputValue3],
          inputLabels: [LABEL_A, LABEL_A, LABEL_A],
          outputValues: [out1, out2, out3],
          outputLabels: [LABEL_A, LABEL_A, LABEL_A],
          amountOut: 0n,
        });

        const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

        await circuit.expectPass(circuitInputs);
      }
    });
  });

  // ============================================================================
  // TEST SUITE: Edge Cases
  // ============================================================================

  describe("Edge Cases", () => {
    let circuit1x2: WitnessTester<
      [
        "stateRoot",
        "keystoreRoot",
        "associationSetRoot",
        "amountOut",
        "tokenIdOut",
        "context",
        "ownerAddress",
        "privateNullifyingKey",
        "privateRevocableKey",
        "keystoreLeafIndex",
        "keystoreSiblings",
        "keystoreTreeDepth",
        "noteSecret",
        "value",
        "tokenId",
        "label",
        "stateLeafIndex",
        "stateSiblings",
        "stateTreeDepth",
        "associationSetLeafIndex",
        "associationSetSiblings",
        "associationSetTreeDepth",
        "timestamp",
        "outputNoteAddressHash",
        "outputValue",
        "outputLabel",
      ],
      ["nullifierHashes", "outputCommitments"]
    >;

    before(async () => {
      circuit1x2 = await circomkit.WitnessTester("Transact_1_2", {
        file: "templates/Transact",
        template: "Transact",
        params: [
          1,
          2,
          STATE_MAX_DEPTH,
          KEYSTORE_MAX_DEPTH,
          ASSOCIATION_SET_MAX_DEPTH,
        ],
        dir: "test/main",
      });
    });

    it("✨ should accept tokenId mismatch when amountOut = 0 (pure transfer bypass)", async () => {
      // The constraint is: (tokenId - tokenIdOut) * (1 - IsZero(amountOut)) === 0
      // When amountOut = 0, the check is skipped regardless of tokenId vs tokenIdOut
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [600n, 400n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Set a different tokenIdOut - should still pass because amountOut = 0
      circuitInputs.tokenIdOut = randomTokenId();

      await circuit1x2.expectPass(circuitInputs);
    });

    it("✨ should reject amountOut that would overflow via conservation", async () => {
      // amountOut has no explicit Num2Bits(128) range check.
      // It is implicitly bounded by conservation: totalIn = outputSum + amountOut.
      // If amountOut >= 2^128, conservation would require impossible input sums.
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [600n, 400n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Set amountOut to 2^128 - conservation will fail since
      // totalIn (1000) != outputSum (1000) + amountOut (2^128)
      circuitInputs.amountOut = 2n ** 128n;

      const error = await circuit1x2.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should handle associationSetRoot = 0 (all-zeros ASP proof)", async () => {
      // FM17: associationSetRoot = 0 could allow bypassing ASP compliance
      // with an all-zeros Merkle proof. The contract prevents this (ASPRegistry
      // rejects root=0), but we document circuit-level behavior here.
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [600n, 400n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Force associationSetRoot = 0 and provide zero proof
      circuitInputs.associationSetRoot = 0n;
      circuitInputs.associationSetLeafIndex = [0n];
      circuitInputs.associationSetSiblings = [
        Array(ASSOCIATION_SET_MAX_DEPTH).fill(0n),
      ];
      circuitInputs.associationSetTreeDepth = [0n];

      // The circuit checks: associationSetProofs[i].out === associationSetRoot
      // BinaryMerkleRoot with depth=0 returns the leaf itself.
      // labelHash = Poseidon(label) which is non-zero, so it won't equal 0.
      // Therefore the circuit rejects this.
      const error = await circuit1x2.expectFail(circuitInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should accept stateTreeDepth = 0 (single-leaf tree)", async () => {
      // Edge case: a tree with exactly 1 leaf has depth 0.
      // BinaryMerkleRoot with depth=0 should return the leaf itself as root.
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [600n, 400n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // With 1 input, createValidInputs creates a 1-leaf state tree.
      // LeanIMT with 1 leaf has depth 0, proof.siblings.length = 0.
      // The stateRoot equals the leaf itself. Depth should be 0.
      expect((circuitInputs.stateTreeDepth as bigint[])[0]).to.equal(0n);

      await circuit1x2.expectPass(circuitInputs);
    });

    it("✨ should accept keystoreTreeDepth = 0 (single-leaf keystore)", async () => {
      // Edge case: keystore tree with exactly 1 leaf has depth 0.
      // createValidInputs builds a 2-leaf keystore tree (depth 1) by default,
      // so we build a custom 1-leaf tree here.
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [600n, 400n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // Rebuild keystore tree with single leaf to get depth 0
      const ownerAddress = inputs.ownerAddress;
      const privateNullifyingKey = inputs.privateNullifyingKey;
      const authDigest = _authDigest;
      const keystoreLeaf = await calculateKeystoreLeaf(
        ownerAddress,
        privateNullifyingKey,
        authDigest,
      );
      const keystoreTree = createTree([keystoreLeaf]);
      const keystoreProof = getProofInputs(keystoreTree, 0, KEYSTORE_MAX_DEPTH);

      circuitInputs.keystoreRoot = keystoreTree.root;
      circuitInputs.keystoreLeafIndex = keystoreProof.index;
      circuitInputs.keystoreSiblings = keystoreProof.siblings;
      circuitInputs.keystoreTreeDepth = keystoreProof.depth;

      expect(circuitInputs.keystoreTreeDepth).to.equal(0n);

      await circuit1x2.expectPass(circuitInputs);
    });

    it("✨ should accept associationSetTreeDepth = 0 (single-label ASP tree)", async () => {
      // Edge case: ASP tree with exactly 1 label has depth 0.
      // With 1 input using 1 unique label, the ASP tree is single-leaf.
      const inputs = await createValidInputs({
        nInputs: 1,
        mOutputs: 2,
        inputValues: [1000n],
        inputLabels: [LABEL_A],
        outputValues: [600n, 400n],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: 0n,
      });

      const { _inputCommitments, _authDigest, ...circuitInputs } = inputs;

      // With 1 unique label, createValidInputs builds a 1-leaf ASP tree (depth 0)
      expect((circuitInputs.associationSetTreeDepth as bigint[])[0]).to.equal(
        0n,
      );

      await circuit1x2.expectPass(circuitInputs);
    });
  });
});
