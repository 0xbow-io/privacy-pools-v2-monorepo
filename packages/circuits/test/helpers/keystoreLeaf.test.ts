// ============================================================================
// KeystoreLeaf Helper - Test Suite
// ============================================================================
// Description:
//   Tests the KeystoreLeaf circuit that computes user keystore leaves
//   from owner address, nullifying key, and authDigest.
//
// Coverage:
//   - Correctness: TypeScript reference validation
//   - authType encoding: Verifies authType=0 (Direct Key) implementation
//   - Determinism: Same inputs produce same outputs
//   - Key binding: All inputs influence output
//   - Collision resistance: Different inputs produce different outputs
//   - Boundary cases: Zero values and max field values
//   - Hash chaining: Two-stage computation correctness
//   - Fuzzing: 50 random inputs, uniqueness testing, input sensitivity
// ============================================================================

import { expect } from "chai";
import { WitnessTester } from "circomkit";
import {
  circomkit,
  calculateKeystoreLeaf,
  computeAuthDigestDirectKey,
  randomFieldElement,
  poseidon,
  AUTH_TYPE,
} from "../common/index.js";

describe("KeystoreLeaf Helper", () => {
  let circuit: WitnessTester<
    ["ownerAddress", "privateNullifyingKey", "authDigest"],
    ["keystoreLeaf"]
  >;

  before(async () => {
    circuit = await circomkit.WitnessTester("KeystoreLeaf", {
      file: "templates/helpers/KeystoreLeaf",
      template: "KeystoreLeaf",
      dir: "test/helpers",
    });
  });

  describe("Correctness", () => {
    it("should match TypeScript reference implementation", async () => {
      const ownerAddress = randomFieldElement();
      const privateNullifyingKey = randomFieldElement();
      const privateRevocableKey = randomFieldElement();

      // Compute authDigest
      const authDigest = await computeAuthDigestDirectKey(privateRevocableKey);

      const inputs = {
        ownerAddress,
        privateNullifyingKey,
        authDigest,
      };

      // Compute expected output using reference
      const expected = await calculateKeystoreLeaf(
        ownerAddress,
        privateNullifyingKey,
        authDigest,
      );

      await circuit.expectPass(inputs, { keystoreLeaf: expected });
    });

    it("✨ should handle realistic EVM address patterns", async () => {
      const ownerAddress = BigInt("0x742d35cc6634c0532925a3b844bc9e7fE0c0F392");
      const privateNullifyingKey = BigInt(
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      );
      const privateRevocableKey = BigInt(
        "0x1234567890123456789012345678901234567890123456789012345678901234",
      );

      // Compute authDigest externally (authType = 0)
      const authDigest = await computeAuthDigestDirectKey(privateRevocableKey);

      const inputs = {
        ownerAddress,
        privateNullifyingKey,
        authDigest,
      };

      const expected = await calculateKeystoreLeaf(
        ownerAddress,
        privateNullifyingKey,
        authDigest,
      );

      await circuit.expectPass(inputs, { keystoreLeaf: expected });
    });
  });

  describe("authType Encoding", () => {
    it("✨ should correctly encode authType = 0 (Direct Key)", async () => {
      const ownerAddress = randomFieldElement();
      const privateNullifyingKey = randomFieldElement();
      const privateRevocableKey = randomFieldElement();

      // Compute authDigest for authType = 0
      const authDigest = await poseidon([
        AUTH_TYPE.DIRECT_KEY,
        privateRevocableKey,
      ]);

      const inputs = {
        ownerAddress,
        privateNullifyingKey,
        authDigest,
      };

      const witness = await circuit.compute(inputs, ["keystoreLeaf"]);

      // Verify manually computed expected value
      const nullifyingKeyHash = await poseidon([privateNullifyingKey]);
      const expected = await poseidon([
        ownerAddress,
        nullifyingKeyHash,
        authDigest,
      ]);

      expect(witness.keystoreLeaf).to.equal(expected);
    });
  });

  describe("Determinism", () => {
    it("✨ should produce same output for same input", async () => {
      const ownerAddress = randomFieldElement();
      const privateNullifyingKey = randomFieldElement();
      const authDigest = randomFieldElement();

      const inputs = {
        ownerAddress,
        privateNullifyingKey,
        authDigest,
      };

      const witness1 = await circuit.compute(inputs, ["keystoreLeaf"]);
      const witness2 = await circuit.compute(inputs, ["keystoreLeaf"]);

      expect(witness1.keystoreLeaf).to.equal(witness2.keystoreLeaf);
    });
  });

  describe("Key Binding", () => {
    it("✨ should produce different outputs for different nullifying keys", async () => {
      const ownerAddress = randomFieldElement();
      const authDigest = randomFieldElement();

      const inputs1 = {
        ownerAddress,
        privateNullifyingKey: randomFieldElement(),
        authDigest,
      };

      const inputs2 = {
        ownerAddress,
        privateNullifyingKey: randomFieldElement(), // Different nullifying key
        authDigest,
      };

      const witness1 = await circuit.compute(inputs1, ["keystoreLeaf"]);
      const witness2 = await circuit.compute(inputs2, ["keystoreLeaf"]);

      expect(witness1.keystoreLeaf).to.not.equal(witness2.keystoreLeaf);
    });

    it("✨ should produce different outputs for different authDigests", async () => {
      const ownerAddress = randomFieldElement();
      const privateNullifyingKey = randomFieldElement();

      const inputs1 = {
        ownerAddress,
        privateNullifyingKey,
        authDigest: randomFieldElement(),
      };

      const inputs2 = {
        ownerAddress,
        privateNullifyingKey,
        authDigest: randomFieldElement(), // Different authDigest
      };

      const witness1 = await circuit.compute(inputs1, ["keystoreLeaf"]);
      const witness2 = await circuit.compute(inputs2, ["keystoreLeaf"]);

      expect(witness1.keystoreLeaf).to.not.equal(witness2.keystoreLeaf);
    });

    it("✨ should produce different outputs for different owner addresses", async () => {
      const privateNullifyingKey = randomFieldElement();
      const authDigest = randomFieldElement();

      const inputs1 = {
        ownerAddress: randomFieldElement(),
        privateNullifyingKey,
        authDigest,
      };

      const inputs2 = {
        ownerAddress: randomFieldElement(), // Different owner address
        privateNullifyingKey,
        authDigest,
      };

      const witness1 = await circuit.compute(inputs1, ["keystoreLeaf"]);
      const witness2 = await circuit.compute(inputs2, ["keystoreLeaf"]);

      expect(witness1.keystoreLeaf).to.not.equal(witness2.keystoreLeaf);
    });
  });

  describe("Collision Resistance", () => {
    it("✨ should produce different outputs for input position swaps", async () => {
      const value1 = randomFieldElement();
      const value2 = randomFieldElement();
      const value3 = randomFieldElement();

      const inputs1 = {
        ownerAddress: value1,
        privateNullifyingKey: value2,
        authDigest: value3,
      };

      const inputs2 = {
        ownerAddress: value1,
        privateNullifyingKey: value3, // Swapped with authDigest
        authDigest: value2, // Swapped with privateNullifyingKey
      };

      const witness1 = await circuit.compute(inputs1, ["keystoreLeaf"]);
      const witness2 = await circuit.compute(inputs2, ["keystoreLeaf"]);

      expect(witness1.keystoreLeaf).to.not.equal(witness2.keystoreLeaf);
    });
  });

  describe("Boundary Cases", () => {
    it("✨ should handle zero values", async () => {
      const inputs = {
        ownerAddress: 0n,
        privateNullifyingKey: 0n,
        authDigest: 0n,
      };

      const expected = await calculateKeystoreLeaf(
        inputs.ownerAddress,
        inputs.privateNullifyingKey,
        inputs.authDigest,
      );

      await circuit.expectPass(inputs, { keystoreLeaf: expected });
    });

    it("✨ should handle large field values", async () => {
      // BN254 field size - 1 (maximum valid value)
      const largeValue =
        21888242871839275222246405745257275088548364400416034343698204186575808495616n -
        1n;

      const inputs = {
        ownerAddress: largeValue,
        privateNullifyingKey: largeValue - 1n,
        authDigest: largeValue - 2n,
      };

      const expected = await calculateKeystoreLeaf(
        inputs.ownerAddress,
        inputs.privateNullifyingKey,
        inputs.authDigest,
      );

      await circuit.expectPass(inputs, { keystoreLeaf: expected });
    });
  });

  describe("Hash Chaining", () => {
    it("✨ should correctly chain hash operations", async () => {
      const ownerAddress = randomFieldElement();
      const privateNullifyingKey = randomFieldElement();
      const authDigest = randomFieldElement();

      const inputs = {
        ownerAddress,
        privateNullifyingKey,
        authDigest,
      };

      const witness = await circuit.compute(inputs, ["keystoreLeaf"]);

      // Manually compute each stage to verify chaining
      const nullifyingKeyHash = await poseidon([privateNullifyingKey]);
      const expectedLeaf = await poseidon([
        ownerAddress,
        nullifyingKeyHash,
        authDigest,
      ]);

      expect(witness.keystoreLeaf).to.equal(expectedLeaf);
    });
  });

  describe("Fuzzing", () => {
    it("✨ should handle 50 random input combinations", async () => {
      for (let i = 0; i < 50; i++) {
        const ownerAddress = randomFieldElement();
        const privateNullifyingKey = randomFieldElement();
        const privateRevocableKey = randomFieldElement();

        // Compute authDigest for authType = 0
        const authDigest =
          await computeAuthDigestDirectKey(privateRevocableKey);

        const inputs = {
          ownerAddress,
          privateNullifyingKey,
          authDigest,
        };

        // Compute expected output
        const expected = await calculateKeystoreLeaf(
          ownerAddress,
          privateNullifyingKey,
          authDigest,
        );

        await circuit.expectPass(inputs, {
          keystoreLeaf: expected,
        });
      }
    });

    it("✨ should maintain uniqueness across 50 random inputs", async () => {
      const outputs = new Set<string>();

      for (let i = 0; i < 50; i++) {
        const inputs = {
          ownerAddress: randomFieldElement(),
          privateNullifyingKey: randomFieldElement(),
          authDigest: randomFieldElement(),
        };

        const witness = await circuit.compute(inputs, ["keystoreLeaf"]);
        outputs.add(witness.keystoreLeaf.toString());
      }

      // All 50 should be unique (collision resistance)
      expect(outputs.size).to.equal(50);
    });

    it("✨ should produce different outputs when any input changes", async () => {
      const baseInputs = {
        ownerAddress: randomFieldElement(),
        privateNullifyingKey: randomFieldElement(),
        authDigest: randomFieldElement(),
      };

      const baseWitness = await circuit.compute(baseInputs, [
        "keystoreLeaf",
      ]);

      // Test 10 variations of each input
      for (let i = 0; i < 10; i++) {
        // Change ownerAddress
        const inputs1 = {
          ...baseInputs,
          ownerAddress: randomFieldElement(),
        };
        const witness1 = await circuit.compute(inputs1, ["keystoreLeaf"]);
        expect(witness1.keystoreLeaf).to.not.equal(
          baseWitness.keystoreLeaf,
        );

        // Change privateNullifyingKey
        const inputs2 = {
          ...baseInputs,
          privateNullifyingKey: randomFieldElement(),
        };
        const witness2 = await circuit.compute(inputs2, ["keystoreLeaf"]);
        expect(witness2.keystoreLeaf).to.not.equal(
          baseWitness.keystoreLeaf,
        );

        // Change authDigest
        const inputs3 = {
          ...baseInputs,
          authDigest: randomFieldElement(),
        };
        const witness3 = await circuit.compute(inputs3, ["keystoreLeaf"]);
        expect(witness3.keystoreLeaf).to.not.equal(
          baseWitness.keystoreLeaf,
        );
      }
    });
  });
});
