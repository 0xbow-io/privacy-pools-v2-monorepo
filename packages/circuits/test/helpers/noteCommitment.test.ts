// ============================================================================
// NoteCommitment Helper - Test Suite
// ============================================================================
// Description:
//   Tests the NoteCommitment circuit that computes cryptographic commitments
//   for notes using a two-stage hashing scheme that binds ownership, value,
//   and lineage information.
//
// Coverage:
//   - Correctness: TypeScript reference validation
//   - Determinism: Same inputs produce same outputs
//   - Collision resistance: Different values/labels/tokenIds produce different outputs
//   - Boundary cases: Zero values and max field values
//   - Two-stage hashing: Precommitment and final commitment separation
//   - Fuzzing: 50 random inputs, uniqueness testing, two-stage verification
// ============================================================================

import { expect } from "chai";
import { WitnessTester } from "circomkit";
import {
  circomkit,
  calculateNoteCommitment,
  randomFieldElement,
  randomValue,
  poseidon,
  EMPTY_METADATA,
} from "../common/index.js";
import { buildPoseidon } from "circomlibjs";

describe("NoteCommitment Helper", () => {
  let circuit: WitnessTester<
    ["noteAddressHash", "tokenId", "value", "metadata", "label"],
    ["commitment"]
  >;
  let poseidon: any;

  before(async () => {
    circuit = await circomkit.WitnessTester("NoteCommitment", {
      file: "templates/helpers/NoteCommitment",
      template: "NoteCommitment",
      dir: "test/helpers",
    });
    poseidon = await buildPoseidon();
  });

  describe("Correctness", () => {
    it("✨ should match TypeScript reference implementation", async () => {
      const inputs = {
        noteAddressHash: 12345n,
        tokenId: 1n,
        value: 100n,
        metadata: EMPTY_METADATA,
        label: 99999n,
      };

      // Compute expected output
      const precommitment = poseidon.F.toString(
        poseidon([
          inputs.noteAddressHash,
          inputs.tokenId,
          inputs.value,
          inputs.metadata,
        ]),
      );
      const expected = poseidon.F.toString(
        poseidon([precommitment, inputs.label]),
      );

      await circuit.expectPass(inputs, { commitment: expected });
    });

    it("✨ should handle realistic note values", async () => {
      const inputs = {
        noteAddressHash: BigInt(
          "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        ),
        tokenId: BigInt("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"), // ETH
        value: 1000000000000000000n, // 1 ETH in wei
        metadata: EMPTY_METADATA,
        label: BigInt(
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        ),
      };

      const precommitment = poseidon.F.toString(
        poseidon([
          inputs.noteAddressHash,
          inputs.tokenId,
          inputs.value,
          inputs.metadata,
        ]),
      );
      const expected = poseidon.F.toString(
        poseidon([precommitment, inputs.label]),
      );

      await circuit.expectPass(inputs, { commitment: expected });
    });
  });

  describe("Determinism", () => {
    it("✨ should produce same output for same input", async () => {
      const inputs = {
        noteAddressHash: 54321n,
        tokenId: 2n,
        value: 250n,
        metadata: EMPTY_METADATA,
        label: 77777n,
      };

      const witness1 = await circuit.compute(inputs, ["commitment"]);
      const witness2 = await circuit.compute(inputs, ["commitment"]);

      expect(witness1.commitment).to.equal(witness2.commitment);
    });
  });

  describe("Collision Resistance", () => {
    it("✨ should produce different outputs for different values", async () => {
      const inputs1 = {
        noteAddressHash: 11111n,
        tokenId: 1n,
        value: 100n,
        metadata: EMPTY_METADATA,
        label: 22222n,
      };

      const inputs2 = {
        ...inputs1,
        value: 200n, // Changed value
      };

      const witness1 = await circuit.compute(inputs1, ["commitment"]);
      const witness2 = await circuit.compute(inputs2, ["commitment"]);

      expect(witness1.commitment).to.not.equal(witness2.commitment);
    });

    it("✨ should produce different outputs for different labels", async () => {
      const inputs1 = {
        noteAddressHash: 11111n,
        tokenId: 1n,
        value: 100n,
        metadata: EMPTY_METADATA,
        label: 22222n,
      };

      const inputs2 = {
        ...inputs1,
        label: 33333n, // Changed label
      };

      const witness1 = await circuit.compute(inputs1, ["commitment"]);
      const witness2 = await circuit.compute(inputs2, ["commitment"]);

      expect(witness1.commitment).to.not.equal(witness2.commitment);
    });

    it("✨ should produce different outputs for different tokenIds", async () => {
      const inputs1 = {
        noteAddressHash: 11111n,
        tokenId: 1n,
        value: 100n,
        metadata: EMPTY_METADATA,
        label: 22222n,
      };

      const inputs2 = {
        ...inputs1,
        tokenId: 2n, // Changed tokenId
      };

      const witness1 = await circuit.compute(inputs1, ["commitment"]);
      const witness2 = await circuit.compute(inputs2, ["commitment"]);

      expect(witness1.commitment).to.not.equal(witness2.commitment);
    });

    it("✨ should produce different outputs for different noteAddressHash", async () => {
      const inputs1 = {
        noteAddressHash: 11111n,
        tokenId: 1n,
        value: 100n,
        metadata: EMPTY_METADATA,
        label: 22222n,
      };

      const inputs2 = {
        ...inputs1,
        noteAddressHash: 99999n, // Changed noteAddressHash
      };

      const witness1 = await circuit.compute(inputs1, ["commitment"]);
      const witness2 = await circuit.compute(inputs2, ["commitment"]);

      expect(witness1.commitment).to.not.equal(witness2.commitment);
    });

    it("✨ should produce different outputs for different metadata", async () => {
      const inputs1 = {
        noteAddressHash: randomFieldElement(),
        tokenId: randomFieldElement(),
        value: randomValue(),
        metadata: EMPTY_METADATA, // Standard note (v2.0)
        label: randomFieldElement(),
      };

      const inputs2 = {
        ...inputs1,
        metadata: 1n, // Non-zero metadata (future note types)
      };

      const witness1 = await circuit.compute(inputs1, ["commitment"]);
      const witness2 = await circuit.compute(inputs2, ["commitment"]);

      expect(witness1.commitment).to.not.equal(witness2.commitment);
    });

    it("✨ should handle non-zero metadata values", async () => {
      // Test with non-zero metadata for future note types
      const inputs = {
        noteAddressHash: randomFieldElement(),
        tokenId: randomFieldElement(),
        value: randomValue(),
        metadata: 42n, // Non-zero metadata
        label: randomFieldElement(),
      };

      const expected = await calculateNoteCommitment(
        inputs.noteAddressHash,
        inputs.tokenId,
        inputs.value,
        inputs.metadata,
        inputs.label,
      );

      await circuit.expectPass(inputs, { commitment: expected });
    });
  });

  describe("Boundary Cases", () => {
    it("✨ should handle zero values", async () => {
      const inputs = {
        noteAddressHash: 0n,
        tokenId: 0n,
        value: 0n,
        metadata: EMPTY_METADATA,
        label: 0n,
      };

      const precommitment = poseidon.F.toString(
        poseidon([
          inputs.noteAddressHash,
          inputs.tokenId,
          inputs.value,
          inputs.metadata,
        ]),
      );
      const expected = poseidon.F.toString(
        poseidon([precommitment, inputs.label]),
      );

      await circuit.expectPass(inputs, { commitment: expected });
    });

    it("✨ should handle large field values", async () => {
      const largeValue =
        21888242871839275222246405745257275088548364400416034343698204186575808495616n -
        1n;

      const inputs = {
        noteAddressHash: largeValue,
        tokenId: largeValue - 1n,
        value: largeValue - 2n,
        metadata: EMPTY_METADATA,
        label: largeValue - 3n,
      };

      const precommitment = poseidon.F.toString(
        poseidon([
          inputs.noteAddressHash,
          inputs.tokenId,
          inputs.value,
          inputs.metadata,
        ]),
      );
      const expected = poseidon.F.toString(
        poseidon([precommitment, inputs.label]),
      );

      await circuit.expectPass(inputs, { commitment: expected });
    });
  });

  describe("Two-stage hashing property", () => {
    it("✨ should correctly separate precommitment and label stages", async () => {
      // Two notes with same precommitment inputs but different labels
      const baseInputs = {
        noteAddressHash: 11111n,
        tokenId: 1n,
        value: 100n,
        metadata: EMPTY_METADATA,
      };

      const inputs1 = { ...baseInputs, label: 22222n };
      const inputs2 = { ...baseInputs, label: 33333n };

      const witness1 = await circuit.compute(inputs1, ["commitment"]);
      const witness2 = await circuit.compute(inputs2, ["commitment"]);

      // Different labels should produce different final commitments
      expect(witness1.commitment).to.not.equal(witness2.commitment);

      // Verify they share the same precommitment conceptually
      const precommitment = poseidon([
        baseInputs.noteAddressHash,
        baseInputs.tokenId,
        baseInputs.value,
        baseInputs.metadata,
      ]);
      const expected1 = poseidon.F.toString(
        poseidon([precommitment, inputs1.label]),
      );
      const expected2 = poseidon.F.toString(
        poseidon([precommitment, inputs2.label]),
      );

      expect(witness1.commitment.toString()).to.equal(expected1);
      expect(witness2.commitment.toString()).to.equal(expected2);
    });
  });

  describe("Fuzzing", () => {
    it("✨ should handle 50 random input combinations", async () => {
      for (let i = 0; i < 50; i++) {
        const inputs = {
          noteAddressHash: randomFieldElement(),
          tokenId: randomFieldElement(),
          value: randomValue(),
          metadata: randomFieldElement(),
          label: randomFieldElement(),
        };

        // Compute expected output
        const expected = await calculateNoteCommitment(
          inputs.noteAddressHash,
          inputs.tokenId,
          inputs.value,
          inputs.metadata,
          inputs.label,
        );

        await circuit.expectPass(inputs, {
          commitment: expected,
        });
      }
    });

    it("✨ should maintain uniqueness across 50 random inputs", async () => {
      const outputs = new Set<string>();

      for (let i = 0; i < 50; i++) {
        const inputs = {
          noteAddressHash: randomFieldElement(),
          tokenId: randomFieldElement(),
          value: randomValue(),
          metadata: randomFieldElement(),
          label: randomFieldElement(),
        };

        const witness = await circuit.compute(inputs, ["commitment"]);
        outputs.add(witness.commitment.toString());
      }

      // All 50 should be unique (collision resistance)
      expect(outputs.size).to.equal(50);
    });

    it("✨ should produce different outputs when any input changes", async () => {
      const baseInputs = {
        noteAddressHash: randomFieldElement(),
        tokenId: randomFieldElement(),
        value: randomValue(),
        metadata: randomFieldElement(),
        label: randomFieldElement(),
      };

      const baseWitness = await circuit.compute(baseInputs, ["commitment"]);

      // Test 10 variations of each input
      for (let i = 0; i < 10; i++) {
        // Change noteAddressHash
        const inputs1 = {
          ...baseInputs,
          noteAddressHash: randomFieldElement(),
        };
        const witness1 = await circuit.compute(inputs1, ["commitment"]);
        expect(witness1.commitment).to.not.equal(baseWitness.commitment);

        // Change tokenId
        const inputs2 = { ...baseInputs, tokenId: randomFieldElement() };
        const witness2 = await circuit.compute(inputs2, ["commitment"]);
        expect(witness2.commitment).to.not.equal(baseWitness.commitment);

        // Change value
        const inputs3 = { ...baseInputs, value: randomValue() };
        const witness3 = await circuit.compute(inputs3, ["commitment"]);
        expect(witness3.commitment).to.not.equal(baseWitness.commitment);

        // Change metadata
        const inputs4 = { ...baseInputs, metadata: randomFieldElement() };
        const witness4 = await circuit.compute(inputs4, ["commitment"]);
        expect(witness4.commitment).to.not.equal(baseWitness.commitment);

        // Change label
        const inputs5 = { ...baseInputs, label: randomFieldElement() };
        const witness5 = await circuit.compute(inputs5, ["commitment"]);
        expect(witness5.commitment).to.not.equal(baseWitness.commitment);
      }
    });

    it("✨ should verify two-stage hashing with random values", async () => {
      for (let i = 0; i < 20; i++) {
        const baseInputs = {
          noteAddressHash: randomFieldElement(),
          tokenId: randomFieldElement(),
          value: randomValue(),
          metadata: randomFieldElement(),
          label: randomFieldElement(),
        };

        // Two notes with same core properties but different labels
        const inputs1 = { ...baseInputs, label: randomFieldElement() };
        const inputs2 = { ...baseInputs, label: randomFieldElement() };

        const witness1 = await circuit.compute(inputs1, ["commitment"]);
        const witness2 = await circuit.compute(inputs2, ["commitment"]);

        // Different labels should produce different commitments
        expect(witness1.commitment).to.not.equal(witness2.commitment);
      }
    });
  });
});
