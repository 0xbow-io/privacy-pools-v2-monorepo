// ============================================================================
// ValueConservation Helper - Test Suite
// ============================================================================
// Description:
//   Tests the ValueConservation circuit that enforces both global and per-label
//   value conservation in transactions. Prevents value creation and cross-label
//   laundering attacks.
//
// Coverage:
//   - Global conservation: Total inputs = total outputs + amountOut
//   - Per-label conservation: For each label, inputs >= outputs
//   - Edge cases: Zero values, all different labels, withdrawal patterns
//   - Determinism: Same inputs produce consistent results
//   - Multiple configurations: (1,1), (2,2), (3,2), (5,2) input/output combinations
//   - TypeScript reference validation
//   - Fuzzing: Random values with same labels, mixed labels
// ============================================================================

import { expect } from "chai";
import { WitnessTester } from "circomkit";
import {
  circomkit,
  verifyValueConservation,
  randomValue,
  randomFieldElement,
} from "../common/index.js";

// Test label constants for readability
const LABEL_A = 1n;
const LABEL_B = 2n;
const LABEL_C = 99n;

describe("ValueConservation Helper", () => {
  // ============================================================================
  // TEST SUITE: (2, 2) - 2 inputs, 2 outputs
  // ============================================================================

  describe("Configuration: 2 inputs, 2 outputs", () => {
    let circuit: WitnessTester<
      [
        "inputValues",
        "inputLabels",
        "outputValues",
        "outputLabels",
        "amountOut",
      ],
      []
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("ValueConservation_2_2", {
        file: "templates/helpers/ValueConservation",
        template: "ValueConservation",
        params: [2, 2],
        dir: "test/helpers",
      });
    });

    describe("Global Conservation", () => {
      it("✨ should accept valid: inputs = outputs + amountOut", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [BigInt(700), BigInt(600)],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: BigInt(200),
        };

        // Verify: 1000 + 500 = 700 + 600 + 200
        await circuit.expectPass(inputs, {});
      });

      it("✨ should accept valid: amountOut = 0 (pure transfer)", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [BigInt(900), BigInt(600)],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: BigInt(0),
        };

        // Verify: 1000 + 500 = 900 + 600
        await circuit.expectPass(inputs, {});
      });

      it("✨ should reject invalid: inputs < outputs", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [BigInt(1000), BigInt(600)], // Total output = 1600 > 1500
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: BigInt(0),
        };

        // Verify: 1000 + 500 ≠ 1000 + 600 (should fail)
        // Expected failure: Global conservation constraint (line 67: totalIn === totalOut)
        const error = await circuit.expectFail(inputs);
        expect(error).to.include("Assert Failed");
      });

      it("✨ should reject invalid: inputs > outputs + amountOut", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [BigInt(500), BigInt(400)], // Total = 900 < 1500
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: BigInt(0),
        };

        // Verify: 1000 + 500 ≠ 500 + 400 (should fail)
        // Expected failure: Global conservation constraint (line 67: totalIn === totalOut)
        const error = await circuit.expectFail(inputs);
        expect(error).to.include("Assert Failed");
      });

      it("✨ should handle large values correctly", async () => {
        const inputs = {
          inputValues: [BigInt(10n ** 18n), BigInt(5n * 10n ** 17n)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [BigInt(10n ** 18n), BigInt(5n * 10n ** 17n)],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: BigInt(0),
        };

        await circuit.expectPass(inputs, {});
      });
    });

    describe("Per-Label Conservation", () => {
      it("✨ should accept valid: same label, balanced", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [BigInt(800), BigInt(700)],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: BigInt(0),
        };

        // Both inputs and outputs have label 1
        // Input sum (label 1) = 1500 >= Output sum (label 1) = 1500
        await circuit.expectPass(inputs, {});
      });

      it("✨ should accept valid: multiple labels, each balanced", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_B],
          outputValues: [BigInt(600), BigInt(300)],
          outputLabels: [LABEL_A, LABEL_B],
          amountOut: BigInt(600),
        };

        // Label 1: input = 1000, output = 600 (1000 >= 600)
        // Label 2: input = 500, output = 300 (500 >= 300)
        // Global: 1500 = 900 + 600
        await circuit.expectPass(inputs, {});
      });

      it("✨ should accept valid: input has excess for one label", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [BigInt(600), BigInt(400)],
          outputLabels: [LABEL_A, LABEL_B],
          amountOut: BigInt(500),
        };

        // Label 1: input = 1500, output = 600 (1500 >= 600)
        // Label 2: input = 0, output = 400 (0 >= 400? Nope!)
        // Expected failure: Per-label conservation (line 114: conservationChecks.out === 1)
        const error = await circuit.expectFail(inputs);
        expect(error).to.include("Assert Failed");
      });

      it("✨ should reject invalid: label value creation", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_B],
          outputValues: [BigInt(1100), BigInt(400)], // Label 1 output > input
          outputLabels: [LABEL_A, LABEL_B],
          amountOut: BigInt(0),
        };

        // Label 1: input = 1000, output = 1100 (1000 >= 1100? NO!)
        // Expected failure: Per-label conservation constraint (inputSum >= outputSum)
        const error = await circuit.expectFail(inputs);
        expect(error).to.include("Assert Failed");
      });

      it("✨ should reject invalid: output has label not in inputs", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [BigInt(1000), BigInt(500)],
          outputLabels: [LABEL_A, LABEL_C], // Label 99 not in inputs
          amountOut: BigInt(0),
        };

        // Label 1: input = 1500, output = 1000 (OK)
        // Label 99: input = 0, output = 500 (0 >= 500? NO!)
        // Expected failure: Per-label conservation (line 114: conservationChecks.out === 1)
        const error = await circuit.expectFail(inputs);
        expect(error).to.include("Assert Failed");
      });

      it("✨ should accept valid: inputs exceed outputs for same label", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [BigInt(500), BigInt(500)],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: BigInt(500), // Excess goes to withdrawal
        };

        // Label 1: input = 1500, output = 1000 (1500 >= 1000)
        // Global: 1500 = 1000 + 500
        await circuit.expectPass(inputs, {});
      });

      it(" ✨ should reject when multiple outputs with same label exceed input sum for that label", async () => {
        // Expected: Circuit rejects this input (test uses expectFail).
        // If test fails: Circuit accepted invalid input, indicating the bug exists.
        // If test passes: Circuit correctly rejected, indicating the fix is in place.

        const inputs = {
          inputValues: [BigInt(50), BigInt(50)],
          inputLabels: [LABEL_A, LABEL_B],
          outputValues: [BigInt(40), BigInt(40)],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: BigInt(20),
        };

        // Expected failure: Per-label conservation (line 114: conservationChecks.out === 1)
        // LABEL_A: input=50, output=80 (fails)
        const error = await circuit.expectFail(inputs);
        expect(error).to.include("Assert Failed");
      });
    });

    describe("Edge Cases", () => {
      it("✨ should handle zero values", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(0)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [BigInt(1000), BigInt(0)],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: BigInt(0),
        };

        await circuit.expectPass(inputs, {});
      });

      it("✨ should handle all different labels", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_B],
          outputValues: [BigInt(900), BigInt(400)],
          outputLabels: [LABEL_A, LABEL_B],
          amountOut: BigInt(200),
        };

        // Label 1: 1000 >= 900
        // Label 2: 500 >= 400
        // Global: 1500 = 1300 + 200
        await circuit.expectPass(inputs, {});
      });

      it("✨ should handle withdrawal from one label only", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_B],
          outputValues: [BigInt(400), BigInt(500)],
          outputLabels: [LABEL_A, LABEL_B],
          amountOut: BigInt(600), // Withdrawn from label 1
        };

        // Label 1: 1000 >= 400
        // Label 2: 500 >= 500
        // Global: 1500 = 900 + 600
        await circuit.expectPass(inputs, {});
      });
    });

    // ValueConservation range-checks every value input at template entry.
    // Without these, the per-label LessEqThan(128) comparator could be fooled
    // by near-prime field elements that wrap mod p inside its internal
    // Num2Bits. Each test below sets a single value at the 2^128 boundary
    // while keeping all other inputs / outputs / amountOut in-bounds and
    // conservation (global + per-label + label inheritance) satisfiable, so
    // witness generation fails on the named constraint and only the named one.
    describe("Range Checks (AW-M-01)", () => {
      const TWO_128 = 1n << 128n;
      const MAX_128 = TWO_128 - 1n;

      it("✨ should reject inputValue at the 2^128 boundary", async () => {
        // Conservation: TWO_128 + 0 === 1 + 0 + (TWO_128 - 1).
        // Only inputValueRangeChecks[0] fails (TWO_128 doesn't fit in 128 bits).
        const inputs = {
          inputValues: [TWO_128, BigInt(0)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [BigInt(1), BigInt(0)],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: MAX_128,
        };
        const error = await circuit.expectFail(inputs);
        expect(error).to.exist;
      });

      it("✨ should reject outputValue at the 2^128 boundary", async () => {
        // Conservation: (TWO_128 - 1) + 1 === TWO_128 + 0 + 0.
        // Only outputValueRangeChecks[0] fails.
        const inputs = {
          inputValues: [MAX_128, BigInt(1)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [TWO_128, BigInt(0)],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: BigInt(0),
        };
        const error = await circuit.expectFail(inputs);
        expect(error).to.exist;
      });

      it("✨ should reject amountOut at the 2^128 boundary", async () => {
        // Conservation: (TWO_128 - 1) + 1 === 0 + 0 + TWO_128.
        // Inputs split across labels A and B so per-label inputAccum for A
        // stays under 2^128 and the LessEqThan(128) check doesn't field-wrap;
        // only outputLabel A is checked (per-label conservation iterates
        // output labels), and its inputAccum == MAX_128 fits.
        // Only amountOutRangeCheck fails.
        const inputs = {
          inputValues: [MAX_128, BigInt(1)],
          inputLabels: [LABEL_A, LABEL_B],
          outputValues: [BigInt(0), BigInt(0)],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: TWO_128,
        };
        const error = await circuit.expectFail(inputs);
        expect(error).to.exist;
      });
    });

    // AW-L-01: every output label must be inherited from at least one input.
    // Closes the 0-value spoofing case where the per-label conservation check
    // is trivially satisfied (0 <= 0) for foreign labels, which would
    // otherwise let an attacker emit Ragequit events with arbitrary labels.
    describe("Label Inheritance (AW-L-01)", () => {
      it("✨ should accept when all output labels match input labels", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_B],
          outputValues: [BigInt(700), BigInt(400)],
          outputLabels: [LABEL_A, LABEL_B],
          amountOut: BigInt(400),
        };
        await circuit.expectPass(inputs, {});
      });

      it("✨ should reject zero-value output with foreign label (original AW-L-01 attack)", async () => {
        // Attacker has inputs labeled A only, but tries to emit a zero-value
        // output labeled C. Pre-fix: per-label check passes trivially (0 <= 0).
        // Post-fix: labelInherited rejects, because no input has label C.
        const inputs = {
          inputValues: [BigInt(1000), BigInt(0)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [BigInt(1000), BigInt(0)],
          outputLabels: [LABEL_A, LABEL_C],
          amountOut: BigInt(0),
        };
        const error = await circuit.expectFail(inputs);
        expect(error).to.exist;
      });

      // Accepted residual: amplification. One legitimate input enables many
      // zero-value outputs with the SAME (matching) label. The labelInherited
      // check passes because at least one input matches, even when subsequent
      // outputs are zero-value. Documented as out of scope in AW-L-01 ticket.
      it("✨ should accept amplification (one matching input enables zero-value outputs with same label)", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(0)],
          inputLabels: [LABEL_A, LABEL_A],
          outputValues: [BigInt(1000), BigInt(0)],
          outputLabels: [LABEL_A, LABEL_A],
          amountOut: BigInt(0),
        };
        await circuit.expectPass(inputs, {});
      });
    });

    describe("Determinism", () => {
      it("✨ should produce consistent results for same inputs", async () => {
        const inputs = {
          inputValues: [BigInt(1000), BigInt(500)],
          inputLabels: [LABEL_A, LABEL_B],
          outputValues: [BigInt(700), BigInt(400)],
          outputLabels: [LABEL_A, LABEL_B],
          amountOut: BigInt(400),
        };

        // Run twice, both should pass
        await circuit.expectPass(inputs, {});
        await circuit.expectPass(inputs, {});
      });
    });
  });

  // ============================================================================
  // TEST SUITE: (3, 2) - 3 inputs, 2 outputs
  // ============================================================================

  describe("Configuration: 3 inputs, 2 outputs", () => {
    let circuit: WitnessTester<
      [
        "inputValues",
        "inputLabels",
        "outputValues",
        "outputLabels",
        "amountOut",
      ],
      []
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("ValueConservation_3_2", {
        file: "templates/helpers/ValueConservation",
        template: "ValueConservation",
        params: [3, 2],
        dir: "test/helpers",
      });
    });

    it("✨ should accept valid: 3 inputs, 2 outputs, mixed labels", async () => {
      const inputs = {
        inputValues: [BigInt(1000), BigInt(500), BigInt(300)],
        inputLabels: [LABEL_A, LABEL_B, LABEL_A],
        outputValues: [BigInt(800), BigInt(400)],
        outputLabels: [LABEL_A, LABEL_B],
        amountOut: BigInt(600),
      };

      // Label 1: inputs = 1000 + 300 = 1300, output = 800 (1300 >= 800)
      // Label 2: inputs = 500, output = 400 (500 >= 400)
      // Global: 1800 = 1200 + 600
      await circuit.expectPass(inputs, {});
    });

    it("✨ should reject invalid: one label exceeds", async () => {
      const inputs = {
        inputValues: [BigInt(1000), BigInt(500), BigInt(300)],
        inputLabels: [LABEL_A, LABEL_B, LABEL_A],
        outputValues: [BigInt(1400), BigInt(400)], // Label 1 output exceeds input
        outputLabels: [LABEL_A, LABEL_B],
        amountOut: BigInt(0),
      };

      // Label 1: inputs = 1300, output = 1400 (1300 >= 1400?)
      // Expected failure: Per-label conservation (line 114: conservationChecks.out === 1)
      const error = await circuit.expectFail(inputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should accept valid: all inputs same label", async () => {
      const inputs = {
        inputValues: [BigInt(1000), BigInt(500), BigInt(300)],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A],
        outputValues: [BigInt(900), BigInt(700)],
        outputLabels: [LABEL_A, LABEL_A],
        amountOut: BigInt(200),
      };

      // Label 1: inputs = 1800, outputs = 1600 (1800 >= 1600)
      await circuit.expectPass(inputs, {});
    });
  });

  // ============================================================================
  // TEST SUITE: (5, 2) - 5 inputs, 2 outputs
  // ============================================================================

  describe("Configuration: 5 inputs, 2 outputs", () => {
    let circuit: WitnessTester<
      [
        "inputValues",
        "inputLabels",
        "outputValues",
        "outputLabels",
        "amountOut",
      ],
      []
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("ValueConservation_5_2", {
        file: "templates/helpers/ValueConservation",
        template: "ValueConservation",
        params: [5, 2],
        dir: "test/helpers",
      });
    });

    it("✨ should accept valid: many inputs consolidating to 2 outputs", async () => {
      const inputs = {
        inputValues: [
          BigInt(100),
          BigInt(200),
          BigInt(300),
          BigInt(400),
          BigInt(500),
        ],
        inputLabels: [LABEL_A, LABEL_A, LABEL_B, LABEL_B, LABEL_A],
        outputValues: [BigInt(600), BigInt(500)],
        outputLabels: [LABEL_A, LABEL_B],
        amountOut: BigInt(400),
      };

      // Label 1: inputs = 100+200+500 = 800, output = 600 (800 >= 600)
      // Label 2: inputs = 300+400 = 700, output = 500 (700 >= 500)
      // Global: 1500 = 1100 + 400
      await circuit.expectPass(inputs, {});
    });

    it("✨ should reject invalid: global conservation fails with many inputs", async () => {
      const inputs = {
        inputValues: [
          BigInt(100),
          BigInt(200),
          BigInt(300),
          BigInt(400),
          BigInt(500),
        ],
        inputLabels: [LABEL_A, LABEL_A, LABEL_B, LABEL_B, LABEL_A],
        outputValues: [BigInt(700), BigInt(500)], // Total output = 1200
        outputLabels: [LABEL_A, LABEL_B],
        amountOut: BigInt(500), // Total output side = 1700 > 1500
      };

      // Global: 1500 ≠ 1200 + 500 (should fail)
      // Expected failure: Global conservation constraint (line 67: totalIn === totalOut)
      const error = await circuit.expectFail(inputs);
      expect(error).to.include("Assert Failed");
    });
  });

  // ============================================================================
  // TEST SUITE: (1, 1)
  // ============================================================================

  describe("Configuration: 1 input, 1 output", () => {
    let circuit: WitnessTester<
      [
        "inputValues",
        "inputLabels",
        "outputValues",
        "outputLabels",
        "amountOut",
      ],
      []
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("ValueConservation_1_1", {
        file: "templates/helpers/ValueConservation",
        template: "ValueConservation",
        params: [1, 1],
        dir: "test/helpers",
      });
    });

    it("✨ should accept valid: single input to single output", async () => {
      const inputs = {
        inputValues: [BigInt(1000)],
        inputLabels: [LABEL_A],
        outputValues: [BigInt(900)],
        outputLabels: [LABEL_A],
        amountOut: BigInt(100),
      };

      await circuit.expectPass(inputs, {});
    });

    it("✨ should reject invalid: output exceeds input", async () => {
      const inputs = {
        inputValues: [BigInt(1000)],
        inputLabels: [LABEL_A],
        outputValues: [BigInt(1100)],
        outputLabels: [LABEL_A],
        amountOut: BigInt(0),
      };

      // Expected failure: Global conservation constraint (line 67: totalIn === totalOut)
      const error = await circuit.expectFail(inputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should reject invalid: different labels (label laundering)", async () => {
      const inputs = {
        inputValues: [BigInt(1000)],
        inputLabels: [LABEL_A],
        outputValues: [BigInt(1000)],
        outputLabels: [LABEL_B], // Different label
        amountOut: BigInt(0),
      };

      // Label 2: input = 0, output = 1000 (should fail)
      // Expected failure: Per-label conservation (line 114: conservationChecks.out === 1)
      const error = await circuit.expectFail(inputs);
      expect(error).to.include("Assert Failed");
    });
  });

  // ============================================================================
  // TEST SUITE: (2, 3) - 2 inputs, 3 outputs
  // ============================================================================

  describe("Configuration: 2 inputs, 3 outputs", () => {
    let circuit: WitnessTester<
      [
        "inputValues",
        "inputLabels",
        "outputValues",
        "outputLabels",
        "amountOut",
      ],
      []
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("ValueConservation_2_3", {
        file: "templates/helpers/ValueConservation",
        template: "ValueConservation",
        params: [2, 3],
        dir: "test/helpers",
      });
    });

    it("✨ should accept valid: 2 inputs, 3 outputs, mixed labels", async () => {
      const inputs = {
        inputValues: [BigInt(1000), BigInt(500)],
        inputLabels: [LABEL_A, LABEL_B],
        outputValues: [BigInt(400), BigInt(300), BigInt(300)],
        outputLabels: [LABEL_A, LABEL_A, LABEL_B],
        amountOut: BigInt(500),
      };

      // Label A: input = 1000, output = 400 + 300 = 700 (1000 >= 700)
      // Label B: input = 500, output = 300 (500 >= 300)
      // Global: 1500 = 1000 + 500
      await circuit.expectPass(inputs, {});
    });

    it("✨ should reject per-label violation across 3 outputs", async () => {
      const inputs = {
        inputValues: [BigInt(1000), BigInt(500)],
        inputLabels: [LABEL_A, LABEL_B],
        outputValues: [BigInt(400), BigInt(400), BigInt(700)],
        outputLabels: [LABEL_A, LABEL_B, LABEL_B],
        amountOut: BigInt(0),
      };

      // Label A: input = 1000, output = 400 (OK)
      // Label B: input = 500, output = 400 + 700 = 1100 (FAIL: 500 < 1100)
      const error = await circuit.expectFail(inputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should accept boundary: all 3 outputs with same label exactly matching input", async () => {
      const inputs = {
        inputValues: [BigInt(900), BigInt(600)],
        inputLabels: [LABEL_A, LABEL_A],
        outputValues: [BigInt(500), BigInt(500), BigInt(500)],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A],
        amountOut: BigInt(0),
      };

      // Label A: input = 1500, output = 1500 (exact boundary)
      await circuit.expectPass(inputs, {});
    });
  });

  // ============================================================================
  // TEST SUITE: (3, 3) - 3 inputs, 3 outputs
  // ============================================================================

  describe("Configuration: 3 inputs, 3 outputs", () => {
    let circuit: WitnessTester<
      [
        "inputValues",
        "inputLabels",
        "outputValues",
        "outputLabels",
        "amountOut",
      ],
      []
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("ValueConservation_3_3", {
        file: "templates/helpers/ValueConservation",
        template: "ValueConservation",
        params: [3, 3],
        dir: "test/helpers",
      });
    });

    it("✨ should accept valid: 3 inputs, 3 outputs, mixed labels", async () => {
      const inputs = {
        inputValues: [BigInt(1000), BigInt(500), BigInt(300)],
        inputLabels: [LABEL_A, LABEL_B, LABEL_C],
        outputValues: [BigInt(800), BigInt(400), BigInt(200)],
        outputLabels: [LABEL_A, LABEL_B, LABEL_C],
        amountOut: BigInt(400),
      };

      // Label A: 1000 >= 800, Label B: 500 >= 400, Label C: 300 >= 200
      // Global: 1800 = 1400 + 400
      await circuit.expectPass(inputs, {});
    });

    it("✨ should reject per-label conservation failure with 3 outputs sharing same label", async () => {
      const inputs = {
        inputValues: [BigInt(1000), BigInt(500), BigInt(300)],
        inputLabels: [LABEL_A, LABEL_A, LABEL_B],
        outputValues: [BigInt(600), BigInt(600), BigInt(600)],
        outputLabels: [LABEL_A, LABEL_A, LABEL_B],
        amountOut: BigInt(0),
      };

      // Label A: input = 1500, output = 1200 (OK)
      // Label B: input = 300, output = 600 (FAIL: 300 < 600)
      const error = await circuit.expectFail(inputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should accept boundary: output sum for label exactly equals input sum", async () => {
      const inputs = {
        inputValues: [BigInt(1000), BigInt(500), BigInt(300)],
        inputLabels: [LABEL_A, LABEL_B, LABEL_C],
        outputValues: [BigInt(1000), BigInt(500), BigInt(300)],
        outputLabels: [LABEL_A, LABEL_B, LABEL_C],
        amountOut: BigInt(0),
      };

      // Exact match for each label — boundary of LessEqThan
      await circuit.expectPass(inputs, {});
    });

    it("✨ should reject cross-label transfer across 3 labels", async () => {
      const inputs = {
        inputValues: [BigInt(1000), BigInt(500), BigInt(300)],
        inputLabels: [LABEL_A, LABEL_B, LABEL_C],
        outputValues: [BigInt(1200), BigInt(300), BigInt(300)],
        outputLabels: [LABEL_A, LABEL_B, LABEL_C],
        amountOut: BigInt(0),
      };

      // Label A: input = 1000, output = 1200 (FAIL: 1000 < 1200)
      const error = await circuit.expectFail(inputs);
      expect(error).to.include("Assert Failed");
    });
  });

  // ============================================================================
  // TEST SUITE: (5, 5) - 5 inputs, 5 outputs
  // ============================================================================

  describe("Configuration: 5 inputs, 5 outputs", () => {
    let circuit: WitnessTester<
      [
        "inputValues",
        "inputLabels",
        "outputValues",
        "outputLabels",
        "amountOut",
      ],
      []
    >;

    before(async () => {
      circuit = await circomkit.WitnessTester("ValueConservation_5_5", {
        file: "templates/helpers/ValueConservation",
        template: "ValueConservation",
        params: [5, 5],
        dir: "test/helpers",
      });
    });

    it("✨ should accept valid: 5 inputs, 5 outputs, mixed labels with withdrawal", async () => {
      const inputs = {
        inputValues: [
          BigInt(100),
          BigInt(200),
          BigInt(300),
          BigInt(400),
          BigInt(500),
        ],
        inputLabels: [LABEL_A, LABEL_B, LABEL_A, LABEL_B, LABEL_C],
        outputValues: [
          BigInt(200),
          BigInt(300),
          BigInt(100),
          BigInt(200),
          BigInt(400),
        ],
        outputLabels: [LABEL_A, LABEL_B, LABEL_A, LABEL_B, LABEL_C],
        amountOut: BigInt(300),
      };

      // Label A: input = 100+300=400, output = 200+100=300 (400 >= 300)
      // Label B: input = 200+400=600, output = 300+200=500 (600 >= 500)
      // Label C: input = 500, output = 400 (500 >= 400)
      // Global: 1500 = 1200 + 300
      await circuit.expectPass(inputs, {});
    });

    it("✨ should reject per-label violation in 5th output", async () => {
      const inputs = {
        inputValues: [
          BigInt(100),
          BigInt(200),
          BigInt(300),
          BigInt(400),
          BigInt(500),
        ],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A, LABEL_B],
        outputValues: [
          BigInt(200),
          BigInt(200),
          BigInt(200),
          BigInt(200),
          BigInt(700),
        ],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A, LABEL_B],
        amountOut: BigInt(0),
      };

      // Label A: input = 1000, output = 800 (OK)
      // Label B: input = 500, output = 700 (FAIL: 500 < 700)
      const error = await circuit.expectFail(inputs);
      expect(error).to.include("Assert Failed");
    });

    it("✨ should accept all 5 outputs with same label when balanced", async () => {
      const inputs = {
        inputValues: [
          BigInt(100),
          BigInt(200),
          BigInt(300),
          BigInt(400),
          BigInt(500),
        ],
        inputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        outputValues: [
          BigInt(300),
          BigInt(300),
          BigInt(300),
          BigInt(300),
          BigInt(300),
        ],
        outputLabels: [LABEL_A, LABEL_A, LABEL_A, LABEL_A, LABEL_A],
        amountOut: BigInt(0),
      };

      // Label A: input = 1500, output = 1500 (exact boundary)
      await circuit.expectPass(inputs, {});
    });
  });

  // ============================================================================
  // TEST SUITE: FUZZING
  // ============================================================================

  describe("Fuzzing (Configuration: 2 inputs, 2 outputs)", () => {
    let circuit_2_2: WitnessTester<
      [
        "inputValues",
        "inputLabels",
        "outputValues",
        "outputLabels",
        "amountOut",
      ],
      []
    >;

    before(async () => {
      circuit_2_2 = await circomkit.WitnessTester("ValueConservation_2_2", {
        file: "templates/helpers/ValueConservation",
        template: "ValueConservation",
        params: [2, 2],
        dir: "test/helpers",
      });
    });

    it("✨ should handle random values with same labels", async () => {
      // Test with random values but same label
      for (let i = 0; i < 20; i++) {
        const label = randomFieldElement();
        const inputValues = [randomValue(), randomValue()];
        const inputLabels = [label, label];

        // Calculate balanced outputs
        const totalIn = inputValues[0] + inputValues[1];
        const halfOut = totalIn / 2n;

        await circuit_2_2.expectPass({
          inputValues,
          inputLabels,
          outputValues: [halfOut, halfOut],
          outputLabels: [label, label],
          amountOut: totalIn - halfOut - halfOut,
        });
      }
    });

    it("✨ should verify conservation with random mixed labels", async () => {
      // Test with two different labels, each conserved separately
      for (let i = 0; i < 15; i++) {
        const label1 = randomFieldElement();
        const label2 = randomFieldElement();

        // Ensure labels are different
        if (label1 === label2) continue;

        const input1 = randomValue();
        const input2 = randomValue();

        await circuit_2_2.expectPass({
          inputValues: [input1, input2],
          inputLabels: [label1, label2],
          outputValues: [input1, input2], // Exact match per label
          outputLabels: [label1, label2],
          amountOut: 0n,
        });
      }
    });
  });

  // ============================================================================
  // TEST SUITE: TypeScript Reference Validation
  // ============================================================================

  describe("TypeScript Reference Validation", () => {
    it("✨ should match TypeScript reference implementation", () => {
      // Test case 1: Valid conservation
      const result1 = verifyValueConservation(
        [BigInt(1000), BigInt(500)],
        [LABEL_A, LABEL_B],
        [BigInt(700), BigInt(400)],
        [LABEL_A, LABEL_B],
        BigInt(400),
      );

      expect(result1.globalValid).to.be.true;
      expect(result1.perLabelValid).to.be.true;

      // Test case 2: Global conservation fails
      const result2 = verifyValueConservation(
        [BigInt(1000), BigInt(500)],
        [LABEL_A, LABEL_B],
        [BigInt(800), BigInt(400)],
        [LABEL_A, LABEL_B],
        BigInt(400), // Total out = 1600 > 1500
      );

      expect(result2.globalValid).to.be.false;

      // Test case 3: Per-label conservation fails
      const result3 = verifyValueConservation(
        [BigInt(1000), BigInt(500)],
        [LABEL_A, LABEL_B],
        [BigInt(1100), BigInt(400)], // Label 1 exceeds
        [LABEL_A, LABEL_B],
        BigInt(0),
      );

      expect(result3.globalValid).to.be.true; // Global still ok
      expect(result3.perLabelValid).to.be.false; // But per-label fails
    });
  });
});
