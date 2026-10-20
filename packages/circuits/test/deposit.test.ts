// ============================================================================
// Deposit Circuit - Test Suite
// ============================================================================
//
// Description:
//   This test suite verifies the security and correctness of the Deposit circuit,
//   which is the entry point for funds into Privacy Pools. It creates note
//   commitments with private label computation.
//
// Coverage:
//   - Correctness: TypeScript reference validation
//   - Determinism: Same inputs always produce same outputs (full witness comparison)
//   - Collision resistance: Different inputs produce different outputs
//   - Permutation Resistance: Input order matters (not commutative)
//   - Value range:  Enforces value < 2^128
//   - Boundary safety: Works with zero values and max field values
//   - Label privacy: different depositSecrets produce different labels
//   - Fuzzing: handles random valid inputs and verifies uniqueness
// ============================================================================

import { expect } from "chai";
import { WitnessTester } from "circomkit";
import {
  circomkit,
  calculateDepositCommitment,
  calculateNoteAddressHash,
  randomFieldElement,
  randomTokenId,
  randomValue,
  DepositInputs,
} from "./common/index.js";

// =================== TEST CONSTANTS ===================

/** BN254 field prime */
const P = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

/** Fixed test values for deterministic tests */
const TEST_OWNER_ADDRESS = 12345n;
const TEST_NOTE_SECRET = 67890n;
const TEST_DEPOSIT_SECRET_A = 11111n;
const TEST_DEPOSIT_SECRET_B = 22222n;
const TEST_TOKEN_ID = 1n;
const TEST_VALUE = 100n;
const TEST_CONTEXT = 42n;

describe("Deposit Circuit", () => {
  let circuit: WitnessTester<
    ["tokenId", "value", "context", "noteAddressHash", "depositSecret"],
    ["outputCommitment"]
  >;

  before(async () => {
    circuit = await circomkit.WitnessTester("deposit", {
      file: "deposit",
      template: "Deposit",
      pubs: ["tokenId", "value", "context"],
      dir: "test/main",
    });
  });

  describe("Correctness", () => {
    it("✨ should match TypeScript reference implementation", async () => {
      // Verify that the circuit produces the same commitment
      // as the reference implementation for normal inputs
      const noteAddressHash = await calculateNoteAddressHash(
        TEST_OWNER_ADDRESS,
        TEST_NOTE_SECRET,
      );
      const inputs: DepositInputs = {
        tokenId: TEST_TOKEN_ID,
        value: TEST_VALUE,
        context: TEST_CONTEXT,
        noteAddressHash,
        depositSecret: TEST_DEPOSIT_SECRET_A,
      };

      // Calculate expected result using reference implementation
      const expected = await calculateDepositCommitment(
        inputs.noteAddressHash,
        inputs.tokenId,
        inputs.value,
        inputs.depositSecret,
      );

      // Verify circuit produces identical result to reference implementation
      await circuit.expectPass(inputs, { outputCommitment: expected });
    });

    it("✨ should handle realistic values", async () => {
      const ownerAddress = BigInt("0x742d35cc6634c0532925a3b844bc9e7fE0c0F392");
      const noteSecret = randomFieldElement();
      const noteAddressHash = await calculateNoteAddressHash(
        ownerAddress,
        noteSecret,
      );

      const inputs: DepositInputs = {
        tokenId: BigInt("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"), // ETH address
        value: 1000000000000000000n, // 1 ETH in wei
        context: randomFieldElement(),
        noteAddressHash,
        depositSecret: randomFieldElement(),
      };

      const expected = await calculateDepositCommitment(
        inputs.noteAddressHash,
        inputs.tokenId,
        inputs.value,
        inputs.depositSecret,
      );

      await circuit.expectPass(inputs, { outputCommitment: expected });
    });
  });

  describe("Determinism", () => {
    it("✨ should produce same output for same inputs", async () => {
      // Verify that the circuit produces identical outputs
      // when given identical inputs across multiple runs
      const noteAddressHash = await calculateNoteAddressHash(
        TEST_OWNER_ADDRESS,
        TEST_NOTE_SECRET,
      );
      const inputs: DepositInputs = {
        tokenId: TEST_TOKEN_ID,
        value: TEST_VALUE,
        context: TEST_CONTEXT,
        noteAddressHash,
        depositSecret: TEST_DEPOSIT_SECRET_A,
      };

      // Calculate full witness (including all intermediate values) twice
      const witness1 = await circuit.calculateWitness(inputs);
      const witness2 = await circuit.calculateWitness(inputs);

      // Both runs must produce identical output commitments
      // witness[1] contains the circuit's output commitment (witness[0] is always 1)
      expect(witness1[1]).to.equal(witness2[1]);

      // Full witness comparison to catch subtle non-determinism in intermediate signals
      expect(witness1).to.deep.equal(witness2);
    });
  });

  describe("Collision Resistance", () => {
    let noteAddressHash: bigint;

    beforeEach(async () => {
      noteAddressHash = await calculateNoteAddressHash(
        TEST_OWNER_ADDRESS,
        TEST_NOTE_SECRET,
      );
    });

    it("✨ should produce different outputs for different values", async () => {
      // Verify that changing the value field produces a completely different commitment
      const base = {
        tokenId: TEST_TOKEN_ID,
        context: TEST_CONTEXT,
        noteAddressHash,
        depositSecret: TEST_DEPOSIT_SECRET_A,
      };

      const witness1 = await circuit.compute({ ...base, value: TEST_VALUE }, [
        "outputCommitment",
      ]);
      const witness2 = await circuit.compute(
        { ...base, value: TEST_VALUE * 2n },
        ["outputCommitment"],
      );

      // Different values MUST produce different commitments
      expect(witness1.outputCommitment).to.not.equal(witness2.outputCommitment);
    });

    it("✨ should produce different outputs for different depositSecrets", async () => {
      // Different depositSecrets should produce different labels,
      // which in turn produce different commitments
      const base = {
        tokenId: TEST_TOKEN_ID,
        value: TEST_VALUE,
        context: TEST_CONTEXT,
        noteAddressHash,
      };

      const witness1 = await circuit.compute(
        { ...base, depositSecret: TEST_DEPOSIT_SECRET_A },
        ["outputCommitment"],
      );
      const witness2 = await circuit.compute(
        { ...base, depositSecret: TEST_DEPOSIT_SECRET_B },
        ["outputCommitment"],
      );

      // Different depositSecrets MUST produce different commitments
      expect(witness1.outputCommitment).to.not.equal(witness2.outputCommitment);
    });

    it("✨ should produce different outputs for different noteAddressHash", async () => {
      // Different noteAddressHashes should produce different commitments
      const noteAddressHash2 = await calculateNoteAddressHash(
        99999n,
        TEST_NOTE_SECRET,
      );
      const base = {
        tokenId: TEST_TOKEN_ID,
        value: TEST_VALUE,
        context: TEST_CONTEXT,
        depositSecret: TEST_DEPOSIT_SECRET_A,
      };

      const witness1 = await circuit.compute({ ...base, noteAddressHash }, [
        "outputCommitment",
      ]);
      const witness2 = await circuit.compute(
        { ...base, noteAddressHash: noteAddressHash2 },
        ["outputCommitment"],
      );

      // Different noteAddressHashes MUST produce different commitments
      expect(witness1.outputCommitment).to.not.equal(witness2.outputCommitment);
    });

    it("✨ should produce different outputs for different tokenIds", async () => {
      // Different tokens should produce different commitments
      const base = {
        value: TEST_VALUE,
        context: TEST_CONTEXT,
        noteAddressHash,
        depositSecret: TEST_DEPOSIT_SECRET_A,
      };

      const witness1 = await circuit.compute(
        { ...base, tokenId: TEST_TOKEN_ID },
        ["outputCommitment"],
      );
      const witness2 = await circuit.compute(
        { ...base, tokenId: TEST_TOKEN_ID + 1n },
        ["outputCommitment"],
      );

      // Different token IDs MUST produce different commitments
      expect(witness1.outputCommitment).to.not.equal(witness2.outputCommitment);
    });

    it("✨ should have systematic collision resistance", async () => {
      // Ensure that even tiny changes to any input field produce completely
      // different commitments. This is critical for security - an attacker
      // should not be able to find two different inputs with the same commitment.
      const baseInputs: DepositInputs = {
        tokenId: TEST_TOKEN_ID,
        value: TEST_VALUE,
        context: TEST_CONTEXT,
        noteAddressHash,
        depositSecret: TEST_DEPOSIT_SECRET_A,
      };

      // Calculate baseline commitment for comparison
      const baseCommitment = await calculateDepositCommitment(
        baseInputs.noteAddressHash,
        baseInputs.tokenId,
        baseInputs.value,
        baseInputs.depositSecret,
      );

      // Create test cases: modify each input field by the smallest possible amount (+1)
      // This tests that the hash function is sensitive to single-bit changes
      const inputsToTest: DepositInputs[] = [
        { ...baseInputs, tokenId: baseInputs.tokenId + 1n },
        { ...baseInputs, value: baseInputs.value + 1n },
        { ...baseInputs, noteAddressHash: baseInputs.noteAddressHash + 1n },
        { ...baseInputs, depositSecret: baseInputs.depositSecret + 1n },
      ];

      // Store all circuit outputs to compare against each other
      const circuitCommitments: bigint[] = [];

      // Verify each modified input produces a different commitment
      for (const inputs of inputsToTest) {
        const newCommitment = await calculateDepositCommitment(
          inputs.noteAddressHash,
          inputs.tokenId,
          inputs.value,
          inputs.depositSecret,
        );
        // Modified input MUST produce different commitment
        expect(newCommitment).to.not.equal(baseCommitment);

        // Verify circuit implementation matches TypeScript reference
        const witness = await circuit.calculateWitness(inputs);
        const circuitCommitment = witness[1]!;
        expect(circuitCommitment).to.equal(newCommitment);

        circuitCommitments.push(circuitCommitment);
      }

      // Ensure all circuit outputs are different from each other
      for (let i = 0; i < circuitCommitments.length; i++) {
        for (let j = i + 1; j < circuitCommitments.length; j++) {
          expect(circuitCommitments[i]).to.not.equal(
            circuitCommitments[j],
            `Circuit outputs should be different for different inputs (test ${i} vs ${j})`,
          );
        }
      }
    });

    it("✨ should have permutation resistance", async () => {
      // Verify that swapping noteAddressHash and depositSecret values
      // produces different commitments.
      const PERM_VAL_A = 111n;
      const PERM_VAL_B = 222n;
      const baseInputs = { tokenId: TEST_TOKEN_ID, value: TEST_VALUE, context: TEST_CONTEXT };

      // Generate both permutations of (noteAddressHash, depositSecret)
      const permutations: DepositInputs[] = [
        {
          ...baseInputs,
          noteAddressHash: PERM_VAL_A,
          depositSecret: PERM_VAL_B,
        },
        {
          ...baseInputs,
          noteAddressHash: PERM_VAL_B,
          depositSecret: PERM_VAL_A,
        },
      ];

      const commitments: bigint[] = [];
      const circuitCommitments: bigint[] = [];

      // Test each permutation
      for (const inputs of permutations) {
        // Calculate commitment using reference
        const commitment = await calculateDepositCommitment(
          inputs.noteAddressHash,
          inputs.tokenId,
          inputs.value,
          inputs.depositSecret,
        );
        commitments.push(commitment);

        // Verify circuit produces the same result
        const witness = await circuit.calculateWitness(inputs);
        const circuitCommitment = witness[1]!;
        expect(circuitCommitment).to.equal(commitment);
        circuitCommitments.push(circuitCommitment);
      }

      // All permutations MUST produce different commitments
      // This ensures the hash function is fully position-sensitive
      for (let i = 0; i < commitments.length; i++) {
        for (let j = i + 1; j < commitments.length; j++) {
          expect(commitments[i]).to.not.equal(
            commitments[j],
            `TypeScript: Permutation ${i} should differ from permutation ${j}`,
          );
          expect(circuitCommitments[i]).to.not.equal(
            circuitCommitments[j],
            `Circuit: Permutation ${i} should differ from permutation ${j}`,
          );
        }
      }
    });
  });

  describe("Value Range Checks", () => {
    let noteAddressHash: bigint;

    beforeEach(async () => {
      noteAddressHash = await calculateNoteAddressHash(
        TEST_OWNER_ADDRESS,
        TEST_NOTE_SECRET,
      );
    });

    it("✨ should accept maximum 128-bit value", async () => {
      // Test with the maximum valid value (2^128 - 1)

      const MAX_128_BIT = 2n ** 128n - 1n;

      const inputs: DepositInputs = {
        tokenId: TEST_TOKEN_ID,
        value: MAX_128_BIT,
        context: TEST_CONTEXT,
        noteAddressHash,
        depositSecret: TEST_DEPOSIT_SECRET_A,
      };

      const expected = await calculateDepositCommitment(
        inputs.noteAddressHash,
        inputs.tokenId,
        inputs.value,
        inputs.depositSecret,
      );

      // Circuit should accept maximum 128-bit value
      await circuit.expectPass(inputs, { outputCommitment: expected });
    });

    it("✨ should reject value >= 2^128", async () => {
      // Verify that the circuit rejects values >= 2^128
      const OVERFLOW_VALUE = 2n ** 128n;
      const inputs: DepositInputs = {
        tokenId: TEST_TOKEN_ID,
        value: OVERFLOW_VALUE, // Exactly 2^128 - should fail
        context: TEST_CONTEXT,
        noteAddressHash,
        depositSecret: TEST_DEPOSIT_SECRET_A,
      };

      // Expected failure: Num2Bits(128) range check (line 39: valueRangeCheck.in <== value)
      const error = await circuit.expectFail(inputs);
      expect(error).to.include("Assert Failed");
    });
  });

  // INS-1: tokenId represents an EVM address (160 bits) onchain. The
  // in-circuit range check (Num2Bits(160)) keeps the proof-side canonical
  // value aligned with the contract-side lower-160-bit cast.
  describe("Token ID Range Check (INS-1)", () => {
    let noteAddressHash: bigint;

    beforeEach(async () => {
      noteAddressHash = await calculateNoteAddressHash(
        TEST_OWNER_ADDRESS,
        TEST_NOTE_SECRET,
      );
    });

    it("✨ should accept tokenId at 2^160 - 1 (max EVM address)", async () => {
      const MAX_160 = (1n << 160n) - 1n;
      const inputs: DepositInputs = {
        tokenId: MAX_160,
        value: TEST_VALUE,
        context: TEST_CONTEXT,
        noteAddressHash,
        depositSecret: TEST_DEPOSIT_SECRET_A,
      };
      const expected = await calculateDepositCommitment(
        inputs.noteAddressHash,
        inputs.tokenId,
        inputs.value,
        inputs.depositSecret,
      );
      await circuit.expectPass(inputs, { outputCommitment: expected });
    });

    it("✨ should reject tokenId at 2^160", async () => {
      const OVERFLOW_TOKEN_ID = 1n << 160n;
      const inputs: DepositInputs = {
        tokenId: OVERFLOW_TOKEN_ID,
        value: TEST_VALUE,
        context: TEST_CONTEXT,
        noteAddressHash,
        depositSecret: TEST_DEPOSIT_SECRET_A,
      };
      const error = await circuit.expectFail(inputs);
      expect(error).to.include("Assert Failed");
    });
  });

  describe("Boundary Cases", () => {
    let noteAddressHash: bigint;

    beforeEach(async () => {
      noteAddressHash = await calculateNoteAddressHash(
        TEST_OWNER_ADDRESS,
        TEST_NOTE_SECRET,
      );
    });

    it("✨ should handle zero value", async () => {
      // Test with zero value deposit

      const inputs: DepositInputs = {
        tokenId: TEST_TOKEN_ID,
        value: 0n,
        context: TEST_CONTEXT,
        noteAddressHash,
        depositSecret: TEST_DEPOSIT_SECRET_A,
      };

      const expected = await calculateDepositCommitment(
        inputs.noteAddressHash,
        inputs.tokenId,
        inputs.value,
        inputs.depositSecret,
      );

      await circuit.expectPass(inputs, { outputCommitment: expected });
    });

    it("✨ should handle zero tokenId", async () => {
      // Test with zero token ID
      const inputs: DepositInputs = {
        tokenId: 0n,
        value: TEST_VALUE,
        context: TEST_CONTEXT,
        noteAddressHash,
        depositSecret: TEST_DEPOSIT_SECRET_A,
      };

      const expected = await calculateDepositCommitment(
        inputs.noteAddressHash,
        inputs.tokenId,
        inputs.value,
        inputs.depositSecret,
      );

      await circuit.expectPass(inputs, { outputCommitment: expected });
    });

    it("✨ should handle maximum field values for secrets", async () => {
      // Test with maximum field values for secret parameters
      const MAX_FIELD_ELEMENT = P - 1n;
      const inputs: DepositInputs = {
        tokenId: TEST_TOKEN_ID,
        value: TEST_VALUE,
        context: TEST_CONTEXT,
        noteAddressHash: MAX_FIELD_ELEMENT,
        depositSecret: MAX_FIELD_ELEMENT,
      };

      const expected = await calculateDepositCommitment(
        inputs.noteAddressHash,
        inputs.tokenId,
        inputs.value,
        inputs.depositSecret,
      );

      await circuit.expectPass(inputs, { outputCommitment: expected });
    });
  });

  describe("Edge Cases", () => {
    it("✨ should accept zero depositSecret", async () => {
      // L-5: depositSecret = 0 is a valid field element.
      // label = Poseidon(precommitment, 0) is predictable but still valid.
      const noteAddressHash = await calculateNoteAddressHash(
        TEST_OWNER_ADDRESS,
        TEST_NOTE_SECRET,
      );
      const inputs: DepositInputs = {
        tokenId: TEST_TOKEN_ID,
        value: TEST_VALUE,
        context: TEST_CONTEXT,
        noteAddressHash,
        depositSecret: 0n,
      };

      const expected = await calculateDepositCommitment(
        inputs.noteAddressHash,
        inputs.tokenId,
        inputs.value,
        inputs.depositSecret,
      );

      // Circuit should accept zero depositSecret and produce a valid commitment
      await circuit.expectPass(inputs, { outputCommitment: expected });
    });

    it("✨ should produce different commitments for zero vs non-zero depositSecret", async () => {
      // Verify that zero depositSecret produces a distinct commitment
      const noteAddressHash = await calculateNoteAddressHash(
        TEST_OWNER_ADDRESS,
        TEST_NOTE_SECRET,
      );
      const base = {
        tokenId: TEST_TOKEN_ID,
        value: TEST_VALUE,
        context: TEST_CONTEXT,
        noteAddressHash,
      };

      const witnessZero = await circuit.compute(
        { ...base, depositSecret: 0n },
        ["outputCommitment"],
      );
      const witnessNonZero = await circuit.compute(
        { ...base, depositSecret: TEST_DEPOSIT_SECRET_A },
        ["outputCommitment"],
      );

      expect(witnessZero.outputCommitment).to.not.equal(
        witnessNonZero.outputCommitment,
      );
    });
  });

  describe("Label Privacy", () => {
    it("✨ should produce different labels for same precommitment with different depositSecrets", async () => {
      // The label is computed inside the circuit using depositSecret
      const noteAddressHash = await calculateNoteAddressHash(
        TEST_OWNER_ADDRESS,
        TEST_NOTE_SECRET,
      );
      const base = {
        tokenId: TEST_TOKEN_ID,
        value: TEST_VALUE,
        context: TEST_CONTEXT,
        noteAddressHash,
      };

      const witness1 = await circuit.compute(
        { ...base, depositSecret: TEST_DEPOSIT_SECRET_A },
        ["outputCommitment"],
      );
      const witness2 = await circuit.compute(
        { ...base, depositSecret: TEST_DEPOSIT_SECRET_B },
        ["outputCommitment"],
      );

      // Different depositSecrets should produce different commitments
      // (because they produce different labels)
      expect(witness1.outputCommitment).to.not.equal(witness2.outputCommitment);
    });
  });

  describe("Fuzzing", () => {
    it("✨ should handle 50 random valid deposits", async () => {
      // Test with random valid inputs to catch edge cases
      for (let i = 0; i < 50; i++) {
        const noteAddressHash = await calculateNoteAddressHash(
          randomFieldElement(),
          randomFieldElement(),
        );
        const inputs: DepositInputs = {
          tokenId: randomTokenId(),
          value: randomValue(), // < 2^128
          context: randomFieldElement(),
          noteAddressHash,
          depositSecret: randomFieldElement(),
        };

        const expected = await calculateDepositCommitment(
          inputs.noteAddressHash,
          inputs.tokenId,
          inputs.value,
          inputs.depositSecret,
        );

        await circuit.expectPass(inputs, { outputCommitment: expected });
      }
    });

    it("✨ should maintain uniqueness across 50 random deposits", async () => {
      // Verify that random inputs produce unique commitments
      const outputs = new Set<string>();

      for (let i = 0; i < 50; i++) {
        const noteAddressHash = await calculateNoteAddressHash(
          randomFieldElement(),
          randomFieldElement(),
        );
        const inputs: DepositInputs = {
          tokenId: randomTokenId(),
          value: randomValue(),
          context: randomFieldElement(),
          noteAddressHash,
          depositSecret: randomFieldElement(),
        };

        const witness = await circuit.compute(inputs, ["outputCommitment"]);
        outputs.add(witness.outputCommitment.toString());
      }

      // All 50 should be unique
      expect(outputs.size).to.equal(50);
    });
  });
});
