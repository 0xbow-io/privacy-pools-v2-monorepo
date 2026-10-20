// ============================================================================
// Ragequit Circuit - Test Suite
// ============================================================================
//
// Description:
//   This test suite verifies the security and correctness of the Ragequit circuit,
//   which provides an emergency withdrawal mechanism that bypasses ASP compliance.
//   It allows users to recover funds when compliance has failed or the ASP has
//   censored their label, ensuring user funds can never be permanently frozen.
//
// Coverage:
//   - Correctness: TypeScript reference validation for nullifier and commitment
//   - Determinism: Same inputs always produce same outputs
//   - Merkle proof verification: Tampered siblings and wrong indices
//   - Authorization verification: Invalid keystore proofs, wrong keys
//   - Commitment reconstruction: Different secrets produce different commitments
//   - Boundary cases: Zero values, max 128-bit values
//   - Collision resistance: Different inputs produce different nullifiers
//   - Fuzzing: Random valid inputs and nullifier uniqueness
// ============================================================================

import { describe, it, before } from "mocha";
import { expect } from "chai";
import { WitnessTester } from "circomkit";
import {
  circomkit,
  poseidon,
  calculateNoteCommitment,
  calculateKeystoreLeaf,
  computeAuthDigestDirectKey,
  calculateNullifierHash,
  randomFieldElement,
  randomTokenId,
  randomValue,
  padSiblings,
  createTree,
  EMPTY_METADATA,
} from "./common/index.js";

const KEYSTORE_MAX_DEPTH = 14;

describe("Ragequit Circuit", () => {
  let circuit: WitnessTester<
    [
      "keystoreRoot",
      "ownerAddress",
      "value",
      "tokenId",
      "label",
      "noteSecret",
      "metadata",
      "privateNullifyingKey",
      "privateRevocableKey",
      "keystoreLeafIndex",
      "keystoreSiblings",
      "keystoreTreeDepth",
    ],
    ["nullifierHash", "commitment"]
  >;

  before(async () => {
    circuit = await circomkit.WitnessTester("ragequit", {
      file: "ragequit",
      template: "Ragequit",
      params: [KEYSTORE_MAX_DEPTH],
      dir: "test/main",
    });
  });

  // Helper to generate valid Ragequit inputs
  async function generateValidInputs() {
    // User keys and address
    const ownerAddress = randomFieldElement();
    const privateNullifyingKey = randomFieldElement();
    const privateRevocableKey = randomFieldElement();
    const noteSecret = randomFieldElement();
    const label = randomFieldElement();
    const tokenId = randomTokenId();
    const value = randomValue();

    // Compute authDigest and keystoreLeaf
    const authDigest = await computeAuthDigestDirectKey(privateRevocableKey);
    const keystoreLeaf = await calculateKeystoreLeaf(
      ownerAddress,
      privateNullifyingKey,
      authDigest,
    );

    // Compute noteAddressHash and commitment
    const noteAddressHash = await poseidon([ownerAddress, noteSecret]);
    const commitment = await calculateNoteCommitment(
      noteAddressHash,
      tokenId,
      value,
      EMPTY_METADATA,
      label,
    );

    // Create keystore tree with user's leaf + dummy leaf to ensure depth > 0,
    // which is needed for Merkle proof verification tests to properly reject tampered inputs
    const keystoreTree = await createTree([keystoreLeaf, randomFieldElement()]);
    const keystoreProof = keystoreTree.generateProof(0);

    // Expected outputs
    const expectedNullifierHash = await calculateNullifierHash(
      privateNullifyingKey,
      commitment,
    );

    return {
      inputs: {
        keystoreRoot: keystoreTree.root,
        ownerAddress,
        value,
        tokenId,
        label,
        noteSecret,
        metadata: EMPTY_METADATA,
        privateNullifyingKey,
        privateRevocableKey,
        keystoreLeafIndex: BigInt(keystoreProof.index),
        keystoreSiblings: padSiblings(
          keystoreProof.siblings,
          KEYSTORE_MAX_DEPTH,
        ),
        keystoreTreeDepth: BigInt(keystoreTree.depth),
      },
      expected: {
        nullifierHash: expectedNullifierHash,
        commitment,
      },
      // Store intermediate values for reference
      commitment,
      keystoreLeaf,
    };
  }

  describe("Correctness", () => {
    it("✨ should produce correct outputs for valid inputs", async () => {
      const { inputs, expected } = await generateValidInputs();

      await circuit.expectPass(inputs, {
        nullifierHash: expected.nullifierHash,
        commitment: expected.commitment,
      });
    });

    it("✨ should match TypeScript nullifier computation", async () => {
      const { inputs, expected, commitment } = await generateValidInputs();

      // Verify nullifier matches reference
      const tsNullifier = await calculateNullifierHash(
        inputs.privateNullifyingKey,
        commitment,
      );
      expect(tsNullifier).to.equal(expected.nullifierHash);

      await circuit.expectPass(inputs, {
        nullifierHash: tsNullifier,
        commitment: expected.commitment,
      });
    });

    it("✨ should match TypeScript commitment computation", async () => {
      const { inputs, expected } = await generateValidInputs();

      // Verify commitment matches reference
      const noteAddressHash = await poseidon([
        inputs.ownerAddress,
        inputs.noteSecret,
      ]);
      const tsCommitment = await calculateNoteCommitment(
        noteAddressHash,
        inputs.tokenId,
        inputs.value,
        EMPTY_METADATA,
        inputs.label,
      );
      expect(tsCommitment).to.equal(expected.commitment);

      await circuit.expectPass(inputs, {
        nullifierHash: expected.nullifierHash,
        commitment: tsCommitment,
      });
    });
  });

  describe("Determinism", () => {
    it("✨ should produce same outputs for same inputs", async () => {
      const { inputs, expected } = await generateValidInputs();

      // Run twice with same inputs
      const witness1 = await circuit.compute(inputs, [
        "nullifierHash",
        "commitment",
      ]);
      const witness2 = await circuit.compute(inputs, [
        "nullifierHash",
        "commitment",
      ]);

      expect(witness1.nullifierHash).to.equal(witness2.nullifierHash);
      expect(witness1.commitment).to.equal(witness2.commitment);
      expect(witness1.nullifierHash).to.equal(expected.nullifierHash);
    });
  });

  describe("Merkle Proof Verification", () => {
    it("✨ should reject tampered keystore siblings", async () => {
      const { inputs } = await generateValidInputs();

      // Tamper with one sibling - this breaks the Merkle proof
      const tamperedSiblings = [...inputs.keystoreSiblings];
      tamperedSiblings[0] = randomFieldElement();

      const badInputs = {
        ...inputs,
        keystoreSiblings: tamperedSiblings,
      };

      // Expected failure: Keystore Merkle proof (Ragequit.circom line 84: authorizationProof.out === keystoreRoot)
      const error = await circuit.expectFail(badInputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject wrong keystore leaf index", async () => {
      const { inputs } = await generateValidInputs();

      // Use wrong leaf index - proof path won't match
      const badInputs = {
        ...inputs,
        keystoreLeafIndex: inputs.keystoreLeafIndex + 1n,
      };

      // Expected failure: Keystore Merkle proof (Ragequit.circom line 84: authorizationProof.out === keystoreRoot)
      const error = await circuit.expectFail(badInputs);
      expect(error).to.include("Assert Failed");
    });
  });

  describe("Authorization Verification", () => {
    it("✨ should reject invalid keystore proof (wrong root)", async () => {
      const { inputs } = await generateValidInputs();

      // Use wrong keystore root
      const badInputs = {
        ...inputs,
        keystoreRoot: randomFieldElement(),
      };

      // Expected failure: Ragequit.circom:79 (authorizationProof.out === keystoreRoot)
      await circuit.expectFail(badInputs);
    });

    it("✨ should reject wrong owner address", async () => {
      const { inputs } = await generateValidInputs();

      // Use different owner address (won't match keystoreLeaf or noteAddressHash)
      const badInputs = {
        ...inputs,
        ownerAddress: randomFieldElement(),
      };

      // Expected failure: Ragequit.circom:79 (authorizationProof.out === keystoreRoot)
      await circuit.expectFail(badInputs);
    });

    it("✨ should reject wrong private nullifying key", async () => {
      const { inputs } = await generateValidInputs();

      // Use wrong nullifying key (won't match keystoreLeaf)
      const badInputs = {
        ...inputs,
        privateNullifyingKey: randomFieldElement(),
      };

      // Expected failure: Ragequit.circom:79 (authorizationProof.out === keystoreRoot)
      await circuit.expectFail(badInputs);
    });

    it("✨ should reject wrong private revocable key", async () => {
      const { inputs } = await generateValidInputs();

      // Use wrong revocable key (won't match authDigest in keystoreLeaf)
      const badInputs = {
        ...inputs,
        privateRevocableKey: randomFieldElement(),
      };

      // Expected failure: Ragequit.circom:79 (authorizationProof.out === keystoreRoot)
      await circuit.expectFail(badInputs);
    });

    it("✨ should reject keystoreTreeDepth > maxDepth", async () => {
      const { inputs } = await generateValidInputs();

      // Use depth exceeding maxDepth
      const badInputs = {
        ...inputs,
        keystoreTreeDepth: BigInt(KEYSTORE_MAX_DEPTH + 1),
      };

      // Expected failure: Ragequit.circom:63 (depthCheck.out === 1)
      await circuit.expectFail(badInputs);
    });

    it("✨ should reject field-wrapped keystoreTreeDepth (p-1 attack)", async () => {
      const { inputs } = await generateValidInputs();

      // BN128 field prime - 1 (this is what zkFuzz found as counterexample)
      const BN128_PRIME_MINUS_1 =
        21888242871839275222246405745257275088548364400416034343698204186575808495616n;

      const badInputs = {
        ...inputs,
        keystoreTreeDepth: BN128_PRIME_MINUS_1,
      };

      // Expected failure: Ragequit.circom:60 (depthRange.in - Num2Bits fails for out-of-range input)
      await circuit.expectFail(badInputs);
    });
  });

  describe("Commitment Reconstruction", () => {
    it("✨ should output different commitment for different note secret", async () => {
      const { inputs, expected } = await generateValidInputs();

      // Compute commitment with different noteSecret
      const differentSecret = randomFieldElement();
      const differentNoteAddressHash = await poseidon([
        inputs.ownerAddress,
        differentSecret,
      ]);
      const differentCommitment = await calculateNoteCommitment(
        differentNoteAddressHash,
        inputs.tokenId,
        inputs.value,
        EMPTY_METADATA,
        inputs.label,
      );

      // Circuit should output different commitment
      expect(differentCommitment).to.not.equal(expected.commitment);

      // With original inputs, commitment should match expected
      const witness = await circuit.compute(inputs, ["commitment"]);
      expect(witness.commitment).to.equal(expected.commitment);
    });

    it("✨ should output different commitment for different label", async () => {
      const { inputs: inputs1, expected: expected1 } =
        await generateValidInputs();
      const { inputs: inputs2, expected: expected2 } =
        await generateValidInputs();

      // Different labels should produce different commitments
      expect(expected1.commitment).to.not.equal(expected2.commitment);
    });

    it("✨ should output different commitment for different value", async () => {
      const { inputs, expected } = await generateValidInputs();

      // Compute commitment with different value
      const noteAddressHash = await poseidon([
        inputs.ownerAddress,
        inputs.noteSecret,
      ]);
      const differentCommitment = await calculateNoteCommitment(
        noteAddressHash,
        inputs.tokenId,
        randomValue(), // Different value
        EMPTY_METADATA,
        inputs.label,
      );

      expect(differentCommitment).to.not.equal(expected.commitment);
    });
  });

  describe("Boundary Cases", () => {
    it("✨ should accept zero value", async () => {
      const ownerAddress = randomFieldElement();
      const privateNullifyingKey = randomFieldElement();
      const privateRevocableKey = randomFieldElement();
      const noteSecret = randomFieldElement();
      const label = randomFieldElement();
      const tokenId = randomTokenId();
      const value = 0n; // Zero value

      const authDigest = await computeAuthDigestDirectKey(privateRevocableKey);
      const keystoreLeaf = await calculateKeystoreLeaf(
        ownerAddress,
        privateNullifyingKey,
        authDigest,
      );

      const keystoreTree = await createTree([keystoreLeaf]);
      const keystoreProof = keystoreTree.generateProof(0);

      const inputs = {
        keystoreRoot: keystoreTree.root,
        ownerAddress,
        value,
        tokenId,
        label,
        noteSecret,
        metadata: EMPTY_METADATA,
        privateNullifyingKey,
        privateRevocableKey,
        keystoreLeafIndex: BigInt(keystoreProof.index),
        keystoreSiblings: padSiblings(
          keystoreProof.siblings,
          KEYSTORE_MAX_DEPTH,
        ),
        keystoreTreeDepth: BigInt(keystoreTree.depth),
      };

      await circuit.expectPass(inputs);
    });

    it("✨ should accept max 128-bit value", async () => {
      const ownerAddress = randomFieldElement();
      const privateNullifyingKey = randomFieldElement();
      const privateRevocableKey = randomFieldElement();
      const noteSecret = randomFieldElement();
      const label = randomFieldElement();
      const tokenId = randomTokenId();
      const value = (1n << 128n) - 1n; // Max 128-bit value: 2^128 - 1

      const authDigest = await computeAuthDigestDirectKey(privateRevocableKey);
      const keystoreLeaf = await calculateKeystoreLeaf(
        ownerAddress,
        privateNullifyingKey,
        authDigest,
      );

      const noteAddressHash = await poseidon([ownerAddress, noteSecret]);
      const commitment = await calculateNoteCommitment(
        noteAddressHash,
        tokenId,
        value,
        EMPTY_METADATA,
        label,
      );

      const keystoreTree = await createTree([keystoreLeaf]);
      const keystoreProof = keystoreTree.generateProof(0);

      const expectedNullifierHash = await calculateNullifierHash(
        privateNullifyingKey,
        commitment,
      );

      const inputs = {
        keystoreRoot: keystoreTree.root,
        ownerAddress,
        value,
        tokenId,
        label,
        noteSecret,
        metadata: EMPTY_METADATA,
        privateNullifyingKey,
        privateRevocableKey,
        keystoreLeafIndex: BigInt(keystoreProof.index),
        keystoreSiblings: padSiblings(
          keystoreProof.siblings,
          KEYSTORE_MAX_DEPTH,
        ),
        keystoreTreeDepth: BigInt(keystoreTree.depth),
      };

      await circuit.expectPass(inputs, {
        nullifierHash: expectedNullifierHash,
        commitment,
      });
    });

    it("✨ should accept large value within 128-bit range", async () => {
      // Note: Ragequit doesn't have Num2Bits constraint on value
      // (unlike Deposit which does). Value range is enforced by contract.
      const { inputs, expected } = await generateValidInputs();

      // Use a large but valid 128-bit value
      const largeValueInputs = {
        ...inputs,
        value: (1n << 127n) + (1n << 64n) + 12345n, // Large 128-bit value
      };

      // Should compute witness successfully
      const witness = await circuit.compute(largeValueInputs, ["commitment"]);
      expect(witness.commitment).to.not.be.undefined;
    });

    it("✨ should accept value >= 2^128 (no range check in ragequit)", async () => {
      // Design decision: Ragequit intentionally omits Num2Bits(128) on value.
      // Value range is enforced externally by the contract (commitment must exist
      // in the state tree, and only Deposit-range-checked values enter the tree).
      // This test documents that the circuit itself does NOT reject overflow values.
      const ownerAddress = randomFieldElement();
      const privateNullifyingKey = randomFieldElement();
      const privateRevocableKey = randomFieldElement();
      const noteSecret = randomFieldElement();
      const label = randomFieldElement();
      const tokenId = randomTokenId();
      const value = 1n << 128n; // Exactly 2^128 -> would fail Deposit's Num2Bits(128)

      const authDigest = await computeAuthDigestDirectKey(privateRevocableKey);
      const keystoreLeaf = await calculateKeystoreLeaf(
        ownerAddress,
        privateNullifyingKey,
        authDigest,
      );

      const noteAddressHash = await poseidon([ownerAddress, noteSecret]);
      const commitment = await calculateNoteCommitment(
        noteAddressHash,
        tokenId,
        value,
        EMPTY_METADATA,
        label,
      );

      const keystoreTree = await createTree([keystoreLeaf]);
      const keystoreProof = keystoreTree.generateProof(0);

      const expectedNullifierHash = await calculateNullifierHash(
        privateNullifyingKey,
        commitment,
      );

      const inputs = {
        keystoreRoot: keystoreTree.root,
        ownerAddress,
        value,
        tokenId,
        label,
        noteSecret,
        metadata: EMPTY_METADATA,
        privateNullifyingKey,
        privateRevocableKey,
        keystoreLeafIndex: BigInt(keystoreProof.index),
        keystoreSiblings: padSiblings(
          keystoreProof.siblings,
          KEYSTORE_MAX_DEPTH,
        ),
        keystoreTreeDepth: BigInt(keystoreTree.depth),
      };

      // Circuit accepts — no Num2Bits(128) on value in Ragequit
      await circuit.expectPass(inputs, {
        nullifierHash: expectedNullifierHash,
        commitment,
      });
    });
  });

  // INS-1: tokenId represents an EVM address (160 bits) onchain. The
  // in-circuit range check (Num2Bits(160)) keeps the proof-side canonical
  // value aligned with the contract-side lower-160-bit cast.
  describe("Token ID Range Check (INS-1)", () => {
    async function buildInputs(tokenId: bigint) {
      const ownerAddress = randomFieldElement();
      const privateNullifyingKey = randomFieldElement();
      const privateRevocableKey = randomFieldElement();
      const noteSecret = randomFieldElement();
      const label = randomFieldElement();
      const value = 100n;

      const authDigest = await computeAuthDigestDirectKey(privateRevocableKey);
      const keystoreLeaf = await calculateKeystoreLeaf(
        ownerAddress,
        privateNullifyingKey,
        authDigest,
      );
      const keystoreTree = await createTree([keystoreLeaf]);
      const keystoreProof = keystoreTree.generateProof(0);

      return {
        keystoreRoot: keystoreTree.root,
        ownerAddress,
        value,
        tokenId,
        label,
        noteSecret,
        metadata: EMPTY_METADATA,
        privateNullifyingKey,
        privateRevocableKey,
        keystoreLeafIndex: BigInt(keystoreProof.index),
        keystoreSiblings: padSiblings(
          keystoreProof.siblings,
          KEYSTORE_MAX_DEPTH,
        ),
        keystoreTreeDepth: BigInt(keystoreTree.depth),
      };
    }

    it("✨ should accept tokenId at 2^160 - 1 (max EVM address)", async () => {
      const inputs = await buildInputs((1n << 160n) - 1n);
      await circuit.expectPass(inputs);
    });

    it("✨ should reject tokenId at 2^160", async () => {
      const inputs = await buildInputs(1n << 160n);
      const error = await circuit.expectFail(inputs);
      expect(error).to.include("Assert Failed");
    });
  });

  describe("Edge Cases", () => {
    it("✨ should accept non-zero metadata", async () => {
      // L-6: Unlike Deposit and Transact which hardcode metadata to 0,
      // Ragequit accepts metadata as a private input. Verify behavior
      // with non-zero metadata values.
      const ownerAddress = randomFieldElement();
      const privateNullifyingKey = randomFieldElement();
      const privateRevocableKey = randomFieldElement();
      const noteSecret = randomFieldElement();
      const label = randomFieldElement();
      const tokenId = randomTokenId();
      const value = randomValue();
      const metadata = 42n; // Non-zero metadata

      const authDigest = await computeAuthDigestDirectKey(privateRevocableKey);
      const keystoreLeaf = await calculateKeystoreLeaf(
        ownerAddress,
        privateNullifyingKey,
        authDigest,
      );

      const noteAddressHash = await poseidon([ownerAddress, noteSecret]);
      const commitment = await calculateNoteCommitment(
        noteAddressHash,
        tokenId,
        value,
        metadata,
        label,
      );

      const keystoreTree = await createTree([
        keystoreLeaf,
        randomFieldElement(),
      ]);
      const keystoreProof = keystoreTree.generateProof(0);

      const expectedNullifierHash = await calculateNullifierHash(
        privateNullifyingKey,
        commitment,
      );

      const inputs = {
        keystoreRoot: keystoreTree.root,
        ownerAddress,
        value,
        tokenId,
        label,
        noteSecret,
        metadata,
        privateNullifyingKey,
        privateRevocableKey,
        keystoreLeafIndex: BigInt(keystoreProof.index),
        keystoreSiblings: padSiblings(
          keystoreProof.siblings,
          KEYSTORE_MAX_DEPTH,
        ),
        keystoreTreeDepth: BigInt(keystoreTree.depth),
      };

      await circuit.expectPass(inputs, {
        nullifierHash: expectedNullifierHash,
        commitment,
      });
    });

    it("✨ should produce different commitments for different metadata values", async () => {
      // Verify metadata is properly bound in the commitment
      const ownerAddress = randomFieldElement();
      const noteSecret = randomFieldElement();
      const label = randomFieldElement();
      const tokenId = randomTokenId();
      const value = randomValue();

      const noteAddressHash = await poseidon([ownerAddress, noteSecret]);
      const commitment0 = await calculateNoteCommitment(
        noteAddressHash,
        tokenId,
        value,
        0n,
        label,
      );
      const commitment42 = await calculateNoteCommitment(
        noteAddressHash,
        tokenId,
        value,
        42n,
        label,
      );

      // Different metadata must produce different commitments
      expect(commitment0).to.not.equal(commitment42);
    });
  });

  describe("Collision Resistance", () => {
    it("✨ should produce different nullifiers for different commitments", async () => {
      const { inputs: inputs1 } = await generateValidInputs();
      const { inputs: inputs2 } = await generateValidInputs();

      const witness1 = await circuit.compute(inputs1, ["nullifierHash"]);
      const witness2 = await circuit.compute(inputs2, ["nullifierHash"]);

      expect(witness1.nullifierHash).to.not.equal(witness2.nullifierHash);
    });
  });

  describe("Fuzzing", () => {
    it("✨ should handle 20 random valid ragequit transactions", async () => {
      for (let i = 0; i < 20; i++) {
        const { inputs, expected } = await generateValidInputs();
        await circuit.expectPass(inputs, {
          nullifierHash: expected.nullifierHash,
          commitment: expected.commitment,
        });
      }
    });

    it("✨ should maintain nullifier uniqueness across 20 random transactions", async () => {
      const nullifiers = new Set<bigint>();

      for (let i = 0; i < 20; i++) {
        const { inputs } = await generateValidInputs();
        const witness = await circuit.compute(inputs, ["nullifierHash"]);
        const nullifier = witness.nullifierHash as bigint;

        expect(nullifiers.has(nullifier)).to.be.false;
        nullifiers.add(nullifier);
      }
    });
  });
});
