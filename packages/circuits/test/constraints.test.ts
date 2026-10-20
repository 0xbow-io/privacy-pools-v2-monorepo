/**
 * CIRCUIT CONSTRAINT ANALYSIS SUITE
 *
 * Lightweight test suite for quick constraint analysis without requiring trusted setup.
 *
 * Useful for:
 *   - Quick circuit complexity assessment during development
 *   - Constraint count regression testing in CI/CD
 *   - Circuit optimization impact measurement
 *
 * METRICS ANALYZED:
 * 1. Total Constraints: Non-linear + Linear constraints
 * 2. Template Instances: Number of circuit component instantiations
 * 3. Wires: Total number of intermediate signals
 * 4. Public/Private I/O: Input/output signal counts
 * 5. File Sizes: R1CS and WASM artifact sizes
 *
 * Run with: pnpm test:constraints
 */

import { circomkit } from "./common/index.js";
import { expect } from "chai";
import * as path from "path";
import {
  existsSync,
  statSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const circuitsConfig = JSON.parse(
  readFileSync(path.join(__dirname, "..", "circuits.json"), "utf-8"),
);

describe("Circuit Constraint Analysis", function () {
  this.timeout(300000); // 5 minutes for all compilations

  interface CircuitStats {
    circuit: string;
    totalConstraints: number;
    nonLinearConstraints: number;
    linearConstraints: number;
    templateInstances: number;
    wires: number;
    publicInputs: number;
    privateInputs: number;
    publicOutputs: number;
    r1csSize: number;
    wasmSize: number;
  }

  interface CircuitConfig {
    file: string;
    template?: string;
    params?: (string | number)[];
    pubs?: string[];
  }

  /**
   * Compiles a circuit and extracts constraint information from the compilation output.
   */
  function analyzeCircuitConstraints(
    circuitName: string,
    circuitConfig: CircuitConfig,
  ): CircuitStats {
    console.log(`\nAnalyzing ${circuitName}...`);

    // Compile the circuit to get fresh stats
    const compileCmd = `npx circomkit compile ${circuitName}`;
    const compileOutput = execSync(compileCmd, {
      encoding: "utf8",
      env: { ...process.env, npm_config_loglevel: "silent" },
      cwd: path.join(__dirname, ".."),
    });

    // Parse the compilation output to extract metrics
    const templateMatch = compileOutput.match(/template instances: (\d+)/);
    const nonLinearMatch = compileOutput.match(/non-linear constraints: (\d+)/);
    const linearMatch = compileOutput.match(/linear constraints: (\d+)/);
    const publicInputsMatch = compileOutput.match(/public inputs: (\d+)/);
    const privateInputsMatch = compileOutput.match(/private inputs: (\d+)/);
    const publicOutputsMatch = compileOutput.match(/public outputs: (\d+)/);
    const wiresMatch = compileOutput.match(/wires: (\d+)/);

    const templateInstances = templateMatch ? parseInt(templateMatch[1]!) : 0;
    const nonLinearConstraints = nonLinearMatch
      ? parseInt(nonLinearMatch[1]!)
      : 0;
    const linearConstraints = linearMatch ? parseInt(linearMatch[1]!) : 0;
    const totalConstraints = nonLinearConstraints + linearConstraints;
    const publicInputs = publicInputsMatch
      ? parseInt(publicInputsMatch[1]!)
      : 0;
    const privateInputs = privateInputsMatch
      ? parseInt(privateInputsMatch[1]!)
      : 0;
    const publicOutputs = publicOutputsMatch
      ? parseInt(publicOutputsMatch[1]!)
      : 0;
    const wires = wiresMatch ? parseInt(wiresMatch[1]!) : 0;

    // Get file sizes
    const buildDir = path.join(__dirname, "..", "build", circuitName);
    const r1csPath = path.join(buildDir, `${circuitName}.r1cs`);
    const wasmPath = path.join(
      buildDir,
      `${circuitName}_js`,
      `${circuitName}.wasm`,
    );

    const r1csSize = existsSync(r1csPath) ? statSync(r1csPath).size : 0;
    const wasmSize = existsSync(wasmPath) ? statSync(wasmPath).size : 0;

    console.log(`  Total Constraints: ${totalConstraints.toLocaleString()}`);
    console.log(`  Template Instances: ${templateInstances.toLocaleString()}`);
    console.log(`  Public Signals: ${publicInputs + publicOutputs}`);
    console.log(`  R1CS Size: ${(r1csSize / 1024).toFixed(1)} KB`);

    return {
      circuit: circuitName,
      totalConstraints,
      nonLinearConstraints,
      linearConstraints,
      templateInstances,
      wires,
      publicInputs,
      privateInputs,
      publicOutputs,
      r1csSize,
      wasmSize,
    };
  }

  const constraintResults: CircuitStats[] = [];

  after(() => {
    if (constraintResults.length === 0) {
      console.log("\nNo constraint analysis results to display.");
      return;
    }

    console.log("\n" + "=".repeat(80));
    console.log("CIRCUIT CONSTRAINT ANALYSIS RESULTS");
    console.log("=".repeat(80) + "\n");

    // Summary table
    console.table(
      constraintResults.map((result) => ({
        Circuit: result.circuit,
        "Total Constraints": result.totalConstraints.toLocaleString(),
        "Non-Linear": result.nonLinearConstraints.toLocaleString(),
        Linear: result.linearConstraints.toLocaleString(),
        Templates: result.templateInstances.toLocaleString(),
        Wires: result.wires.toLocaleString(),
        "Pub In": result.publicInputs,
        "Pub Out": result.publicOutputs,
        "R1CS (KB)": (result.r1csSize / 1024).toFixed(1),
        "WASM (KB)": (result.wasmSize / 1024).toFixed(1),
      })),
    );

    // Complexity analysis
    console.log("\n" + "=".repeat(80));
    console.log("COMPLEXITY ANALYSIS");
    console.log("=".repeat(80));
    const sortedByConstraints = [...constraintResults].sort(
      (a, b) => b.totalConstraints - a.totalConstraints,
    );
    sortedByConstraints.forEach((result, index) => {
      const complexity =
        result.totalConstraints > 50000
          ? "Very High"
          : result.totalConstraints > 20000
            ? "High"
            : result.totalConstraints > 5000
              ? "Medium"
              : "Low";
      console.log(
        `${index + 1}. ${result.circuit}: ${result.totalConstraints.toLocaleString()} constraints (${complexity})`,
      );
    });

    // Transact variants comparison
    const transactCircuits = constraintResults.filter((r) =>
      r.circuit.startsWith("transact_"),
    );
    if (transactCircuits.length > 1) {
      console.log("\n" + "=".repeat(80));
      console.log("TRANSACT VARIANT COMPARISON");
      console.log("=".repeat(80));
      console.log("\nConstraint growth per input/output:");

      // Group by inputs
      const byInputs = new Map<number, CircuitStats[]>();
      transactCircuits.forEach((t) => {
        const match = t.circuit.match(/transact_(\d+)x(\d+)/);
        if (match) {
          const inputs = parseInt(match[1]);
          if (!byInputs.has(inputs)) byInputs.set(inputs, []);
          byInputs.get(inputs)!.push(t);
        }
      });

      byInputs.forEach((circuits, inputs) => {
        circuits.sort((a, b) => {
          const aOutputs = parseInt(a.circuit.match(/x(\d+)/)?.[1] || "0");
          const bOutputs = parseInt(b.circuit.match(/x(\d+)/)?.[1] || "0");
          return aOutputs - bOutputs;
        });
        console.log(`\n  ${inputs} input(s):`);
        circuits.forEach((c) => {
          const outputs = parseInt(c.circuit.match(/x(\d+)/)?.[1] || "0");
          console.log(
            `    ${outputs} output(s): ${c.totalConstraints.toLocaleString()} constraints`,
          );
        });
      });
    }

    // Save detailed results
    const resultsDir = path.join(__dirname, "..", "benchmarks");
    if (!existsSync(resultsDir)) {
      mkdirSync(resultsDir);
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = path.join(
      resultsDir,
      `constraint-analysis-${timestamp}.json`,
    );
    writeFileSync(outputPath, JSON.stringify(constraintResults, null, 2));
    console.log(`\nDetailed results saved to: ${outputPath}`);
  });

  describe("Individual Circuit Analysis", () => {
    const typedCircuitsConfig = circuitsConfig as {
      [key: string]: CircuitConfig;
    };

    for (const [circuitName, circuitConfig] of Object.entries(
      typedCircuitsConfig,
    )) {
      // Only analyze circuits that have a template
      if (!circuitConfig.template) {
        continue;
      }

      describe(`Constraints: ${circuitName}`, function () {
        it("should analyze circuit constraints and complexity", async () => {
          const result = analyzeCircuitConstraints(circuitName, circuitConfig);
          constraintResults.push(result);

          // Basic validation
          expect(result.totalConstraints).to.be.greaterThan(
            0,
            "Circuit should have constraints",
          );
          expect(result.r1csSize).to.be.greaterThan(
            0,
            "R1CS file should exist and have size",
          );
          expect(result.wasmSize).to.be.greaterThan(
            0,
            "WASM file should exist and have size",
          );

          console.log(
            `    ✓ ${circuitName}: ${result.totalConstraints.toLocaleString()} constraints`,
          );
        });
      });
    }
  });
});
