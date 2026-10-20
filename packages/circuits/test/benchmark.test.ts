/**
 * PRIVACY POOLS V2 CIRCUIT BENCHMARK SUITE
 *
 * Measures performance of key operations for each circuit:
 *   - Witness Generation Time
 *   - Proof Generation Time
 *   - Proof Verification Time
 *   - Artifact Sizes
 *
 * NOTE: Full benchmarks read the committed ceremony keys in build/ (git lfs pull; see CEREMONY.md).
 * For constraint analysis without trusted setup, use: pnpm test:constraints
 *
 * Run with: pnpm test:benchmark
 */

import { expect } from "chai";
import * as path from "path";
import { performance } from "perf_hooks";
import {
  readFileSync,
  statSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
import * as snarkjs from "snarkjs";
import { WitnessTester } from "circomkit";
import {
  circomkit,
  poseidon,
  calculateNoteAddressHash,
  calculateKeystoreLeaf,
  computeAuthDigestDirectKey,
  calculateLabelHash,
  calculateNoteCommitment,
  createTree,
  padSiblings,
  randomFieldElement,
  COMMITMENT_LEAF_TAG,
  EMPTY_METADATA,
} from "./common/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const circuitsConfig = JSON.parse(
  readFileSync(path.join(__dirname, "..", "circuits.json"), "utf-8"),
);

// ============================================================================
// CONSTANTS - Read from circuits.json for current configuration
// ============================================================================

// Get tree depths from circuits.json (transact_1x1 has params: [nInputs, mOutputs, stateMaxDepth, keystoreMaxDepth, aspMaxDepth])
const transactConfig = circuitsConfig['transact_1x1'];
const ragequitConfig = circuitsConfig['ragequit'];

const STATE_MAX_DEPTH = transactConfig?.params?.[2] ?? 32;
const KEYSTORE_MAX_DEPTH = transactConfig?.params?.[3] ?? 32;
const ASSOCIATION_SET_MAX_DEPTH = transactConfig?.params?.[4] ?? 32;
const RAGEQUIT_KEYSTORE_DEPTH = ragequitConfig?.params?.[0] ?? 32;

const NUM_SAMPLES = 5;

// ============================================================================
// TYPES
// ============================================================================

interface BenchmarkResult {
  circuit: string;
  constraints: number;
  witnessGenerationTime: TimeStats;
  proofGenerationTime: TimeStats;
  proofVerificationTime: TimeStats;
  r1csSize: number;
  wasmSize: number;
  provingKeySize: number;
  verificationKeySize: number;
}

interface TimeStats {
  avg: number;
  median: number;
  stdDev: number;
  samples: number;
}

interface LocalCircuitConfig {
  file: string;
  template?: string;
  params?: (string | number)[];
  pubs?: string[];
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function calculateStats(samples: number[]): TimeStats {
  if (samples.length === 0) {
    return { avg: 0, median: 0, stdDev: 0, samples: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const variance =
    samples.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) /
    samples.length;
  const stdDev = Math.sqrt(variance);
  return { avg, median, stdDev, samples: samples.length };
}

function getConstraintsFromCompilation(circuitName: string): number {
  try {
    const compileCmd = `npx circomkit compile ${circuitName}`;
    const compileOutput = execSync(compileCmd, {
      encoding: "utf8",
      env: { ...process.env, npm_config_loglevel: "silent" },
      cwd: path.join(__dirname, ".."),
    });

    const nonLinearMatch = compileOutput.match(/non-linear constraints: (\d+)/);
    const linearMatch = compileOutput.match(/linear constraints: (\d+)/);

    const nonLinearConstraints = nonLinearMatch
      ? parseInt(nonLinearMatch[1]!)
      : 0;
    const linearConstraints = linearMatch ? parseInt(linearMatch[1]!) : 0;
    return nonLinearConstraints + linearConstraints;
  } catch (error) {
    console.warn(`Could not get constraints for ${circuitName}:`, error);
    return 0;
  }
}

// ============================================================================
// SAMPLE INPUT GENERATORS
// ============================================================================

async function generateDepositInputs(): Promise<any> {
  const ownerAddress = randomFieldElement();
  const noteSecret = randomFieldElement();
  const depositSecret = randomFieldElement();
  const tokenId = BigInt(1);
  const value = BigInt(1000000);

  const noteAddressHash = await calculateNoteAddressHash(
    ownerAddress,
    noteSecret,
  );

  return {
    tokenId,
    value,
    context: randomFieldElement(),
    noteAddressHash,
    depositSecret,
  };
}

async function generateTransactInputs(
  nInputs: number,
  mOutputs: number,
): Promise<any> {
  const ownerAddress = randomFieldElement();
  const privateNullifyingKey = randomFieldElement();
  const privateRevocableKey = randomFieldElement();
  const tokenId = BigInt(1);
  const label = randomFieldElement();

  // Setup keystore
  const authDigest = await computeAuthDigestDirectKey(privateRevocableKey);
  const keystoreLeaf = await calculateKeystoreLeaf(
    ownerAddress,
    privateNullifyingKey,
    authDigest,
  );
  const keystoreTree = await createTree([keystoreLeaf]);
  const keystoreProof = keystoreTree.generateProof(0);

  // Setup input notes - use value divisible by common factors to avoid conservation issues
  const noteSecrets: bigint[] = [];
  const inputValues: bigint[] = [];
  const inputLabels: bigint[] = [];
  const inputCommitments: bigint[] = [];
  const timestamps: bigint[] = [];

  // Use a value that's divisible by both nInputs and mOutputs to avoid integer division issues
  const baseValue = BigInt(1000000);
  const totalValue = baseValue * BigInt(nInputs);
  const valuePerInput = baseValue; // Each input has baseValue

  for (let i = 0; i < nInputs; i++) {
    const noteSecret = randomFieldElement();
    noteSecrets.push(noteSecret);
    inputValues.push(valuePerInput);
    inputLabels.push(label);

    const noteAddressHash = await calculateNoteAddressHash(
      ownerAddress,
      noteSecret,
    );
    const commitment = await calculateNoteCommitment(
      noteAddressHash,
      tokenId,
      valuePerInput,
      EMPTY_METADATA,
      label,
    );
    inputCommitments.push(commitment);

    // Add timestamp for state tree leaf
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    timestamps.push(timestamp);
  }

  // Build state tree with timestamped leaves (hash(commitment, timestamp))
  const timestampedLeaves: bigint[] = [];
  for (let i = 0; i < nInputs; i++) {
    // timestampedLeaf = Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp)
    const timestampedLeaf = await poseidon([COMMITMENT_LEAF_TAG, inputCommitments[i], timestamps[i]]);
    timestampedLeaves.push(timestampedLeaf);
  }

  // No power-of-2 padding: per-input depths handle variable-depth LeanIMT proofs
  const stateTree = await createTree(timestampedLeaves);

  // Setup ASP tree with label hash
  const labelHash = await calculateLabelHash(label);
  const associationSetTree = await createTree([labelHash]);
  const associationSetProof = associationSetTree.generateProof(0);

  // Setup output notes - ensure value conservation
  const outputNoteAddressHashes: bigint[] = [];
  const outputValues: bigint[] = [];
  const outputLabels: bigint[] = [];

  const amountOut = BigInt(0); // Pure transfer
  const remainingValue = totalValue - amountOut;

  // Distribute value to outputs, with last output getting any remainder
  const valuePerOutput = remainingValue / BigInt(mOutputs);
  let distributedValue = BigInt(0);

  for (let j = 0; j < mOutputs; j++) {
    const recipientAddress = randomFieldElement();
    const recipientNoteSecret = randomFieldElement();
    const outputNoteAddressHash = await calculateNoteAddressHash(
      recipientAddress,
      recipientNoteSecret,
    );
    outputNoteAddressHashes.push(outputNoteAddressHash);

    // Last output gets remaining value to ensure conservation
    const outputValue =
      j === mOutputs - 1 ? remainingValue - distributedValue : valuePerOutput;
    outputValues.push(outputValue);
    distributedValue += outputValue;

    outputLabels.push(label);
  }

  // Build state tree proofs
  const stateSiblings: bigint[][] = [];
  const stateLeafIndices: bigint[] = [];
  const stateTreeDepths: bigint[] = [];

  for (let i = 0; i < nInputs; i++) {
    const proof = stateTree.generateProof(i);
    stateSiblings.push(padSiblings(proof.siblings, STATE_MAX_DEPTH));
    stateLeafIndices.push(BigInt(proof.index));
    stateTreeDepths.push(BigInt(proof.siblings.length));
  }

  // Build association set proofs (same for all inputs since same label)
  const associationSetSiblings: bigint[][] = [];
  const associationSetLeafIndices: bigint[] = [];
  const associationSetTreeDepths: bigint[] = [];

  for (let i = 0; i < nInputs; i++) {
    associationSetSiblings.push(padSiblings(associationSetProof.siblings, ASSOCIATION_SET_MAX_DEPTH));
    associationSetLeafIndices.push(BigInt(associationSetProof.index));
    associationSetTreeDepths.push(BigInt(associationSetProof.siblings.length));
  }

  return {
    // Public inputs
    stateRoot: stateTree.root,
    keystoreRoot: keystoreTree.root,
    associationSetRoot: associationSetTree.root,
    amountOut,
    tokenIdOut: tokenId,
    context: randomFieldElement(),

    // Authorization
    ownerAddress,
    privateNullifyingKey,
    privateRevocableKey,
    keystoreLeafIndex: BigInt(keystoreProof.index),
    keystoreSiblings: padSiblings(keystoreProof.siblings, KEYSTORE_MAX_DEPTH),
    keystoreTreeDepth: BigInt(keystoreTree.depth),

    // Input notes
    noteSecret: noteSecrets,
    value: inputValues,
    label: inputLabels,
    tokenId,
    stateLeafIndex: stateLeafIndices,
    stateSiblings,
    stateTreeDepth: stateTreeDepths,
    associationSetLeafIndex: associationSetLeafIndices,
    associationSetSiblings,
    associationSetTreeDepth: associationSetTreeDepths,
    timestamp: timestamps,

    // Output notes
    outputNoteAddressHash: outputNoteAddressHashes,
    outputValue: outputValues,
    outputLabel: outputLabels,
  };
}

async function generateRagequitInputs(): Promise<any> {
  const ownerAddress = randomFieldElement();
  const noteSecret = randomFieldElement();
  const privateNullifyingKey = randomFieldElement();
  const privateRevocableKey = randomFieldElement();
  const tokenId = BigInt(1);
  const value = BigInt(1000000);
  const label = randomFieldElement();

  // Setup keystore
  const authDigest = await computeAuthDigestDirectKey(privateRevocableKey);
  const keystoreLeaf = await calculateKeystoreLeaf(
    ownerAddress,
    privateNullifyingKey,
    authDigest,
  );
  const keystoreTree = await createTree([keystoreLeaf]);
  const keystoreProof = keystoreTree.generateProof(0);

  return {
    // Public inputs
    keystoreRoot: keystoreTree.root,
    ownerAddress,
    value,
    tokenId,
    label,

    // Private inputs
    noteSecret,
    metadata: EMPTY_METADATA,
    privateNullifyingKey,
    privateRevocableKey,
    keystoreLeafIndex: BigInt(keystoreProof.index),
    keystoreSiblings: padSiblings(keystoreProof.siblings, RAGEQUIT_KEYSTORE_DEPTH),
    keystoreTreeDepth: BigInt(keystoreTree.depth),
  };
}

async function generateSampleInputs(circuitName: string): Promise<any> {
  if (circuitName === "deposit") {
    return generateDepositInputs();
  }

  if (circuitName === "ragequit") {
    return generateRagequitInputs();
  }

  // Parse transact_NxM format
  const transactMatch = circuitName.match(/transact_(\d+)x(\d+)/);
  if (transactMatch) {
    const nInputs = parseInt(transactMatch[1]);
    const mOutputs = parseInt(transactMatch[2]);
    return generateTransactInputs(nInputs, mOutputs);
  }

  throw new Error(`Sample inputs not defined for circuit: ${circuitName}`);
}

// ============================================================================
// BENCHMARK SUITE
// ============================================================================

describe("Privacy Pools V2 Circuit Benchmarks", function () {
  this.timeout(600000); // 10 minutes

  const benchmarkResults: BenchmarkResult[] = [];

  function skipIfMissing(ctx: Mocha.Context, circuitName: string) {
    const buildDir = path.join(__dirname, "..", "build", circuitName);
    const r1csPath = path.join(buildDir, `${circuitName}.r1cs`);
    const wasmPath = path.join(
      buildDir,
      `${circuitName}_js`,
      `${circuitName}.wasm`,
    );
    const pkeyPath = path.join(buildDir, "groth16_pkey.zkey");
    const vkeyPath = path.join(buildDir, "groth16_vkey.json");

    const missingFiles = [];
    if (!existsSync(r1csPath)) missingFiles.push("R1CS");
    if (!existsSync(wasmPath)) missingFiles.push("WASM");
    if (!existsSync(pkeyPath)) missingFiles.push("proving key");
    if (!existsSync(vkeyPath)) missingFiles.push("verification key");

    if (missingFiles.length > 0) {
      console.warn(
        `SKIPPING benchmark for ${circuitName}: missing ${missingFiles.join(", ")}`,
      );
      ctx.skip();
    }
  }

  after(() => {
    if (benchmarkResults.length === 0) {
      console.log("\nNo benchmark results to display.");
      return;
    }

    console.log("\n" + "=".repeat(100));
    console.log("PRIVACY POOLS V2 CIRCUIT BENCHMARK RESULTS");
    console.log("=".repeat(100) + "\n");

    console.table(
      benchmarkResults.map((result) => ({
        Circuit: result.circuit,
        Constraints: result.constraints.toLocaleString(),
        "Witness (ms)": result.witnessGenerationTime.avg.toFixed(2),
        "Prove (ms)": result.proofGenerationTime.avg.toFixed(2),
        "Verify (ms)": result.proofVerificationTime.avg.toFixed(2),
        "PKey (KB)": (result.provingKeySize / 1024).toFixed(0),
        "VKey (KB)": (result.verificationKeySize / 1024).toFixed(1),
      })),
    );

    // Performance summary
    console.log("\n" + "=".repeat(100));
    console.log("PERFORMANCE SUMMARY");
    console.log("=".repeat(100));

    const sortedByProveTime = [...benchmarkResults].sort(
      (a, b) => b.proofGenerationTime.avg - a.proofGenerationTime.avg,
    );

    console.log("\nProof Generation Time (slowest to fastest):");
    sortedByProveTime.forEach((result, index) => {
      console.log(
        `  ${index + 1}. ${result.circuit}: ${result.proofGenerationTime.avg.toFixed(0)} ms`,
      );
    });

    // Save results
    const benchmarkDir = path.join(__dirname, "..", "benchmarks");
    if (!existsSync(benchmarkDir)) {
      mkdirSync(benchmarkDir);
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = path.join(
      benchmarkDir,
      `benchmark-results-${timestamp}.json`,
    );
    writeFileSync(outputPath, JSON.stringify(benchmarkResults, null, 2));
    console.log(`\nBenchmark results saved to: ${outputPath}`);
  });

  async function benchmarkCircuit(
    circuitName: string,
    circuitConfig: LocalCircuitConfig,
    sampleInputs: any,
  ): Promise<BenchmarkResult> {
    console.log(`\nBenchmarking ${circuitName}...`);

    const buildDir = path.join(__dirname, "..", "build", circuitName);
    const r1csPath = path.join(buildDir, `${circuitName}.r1cs`);
    const wasmPath = path.join(
      buildDir,
      `${circuitName}_js`,
      `${circuitName}.wasm`,
    );
    const pkeyPath = path.join(buildDir, "groth16_pkey.zkey");
    const vkeyPath = path.join(buildDir, "groth16_vkey.json");

    // 1. Get constraint count
    const constraints = getConstraintsFromCompilation(circuitName);
    console.log(`  Constraints: ${constraints.toLocaleString()}`);

    // 2. Create circuit tester for witness generation
    const circuit: WitnessTester<any, any> = await circomkit.WitnessTester(
      circuitName,
      circuitConfig as any,
    );

    // 3. Witness Generation Benchmark
    const witnessGenSamples: number[] = [];
    await circuit.calculateWitness(sampleInputs); // Warm-up

    for (let i = 0; i < NUM_SAMPLES; i++) {
      const start = performance.now();
      await circuit.calculateWitness(sampleInputs);
      witnessGenSamples.push(performance.now() - start);
    }
    const witnessGenerationTime = calculateStats(witnessGenSamples);
    console.log(
      `  Witness Generation: ${witnessGenerationTime.avg.toFixed(2)} ms`,
    );

    // 4. Generate witness file for snarkjs
    const wtnsPath = path.join(buildDir, "witness.wtns");
    const WitnessCalculator = require("circom_tester/wasm/witness_calculator");
    const wasmBuffer = readFileSync(wasmPath);
    const witnessCalculator = await WitnessCalculator(wasmBuffer);
    const witnessBuffer = await witnessCalculator.calculateWTNSBin(
      sampleInputs,
      0,
    );
    writeFileSync(wtnsPath, Buffer.from(witnessBuffer));

    // 5. Proof Generation Benchmark
    const proofGenSamples: number[] = [];
    await snarkjs.groth16.prove(pkeyPath, wtnsPath); // Warm-up

    for (let i = 0; i < NUM_SAMPLES; i++) {
      const start = performance.now();
      await snarkjs.groth16.prove(pkeyPath, wtnsPath);
      proofGenSamples.push(performance.now() - start);
    }
    const proofGenerationTime = calculateStats(proofGenSamples);
    console.log(`  Proof Generation: ${proofGenerationTime.avg.toFixed(2)} ms`);

    // 6. Proof Verification Benchmark
    const vkey = JSON.parse(readFileSync(vkeyPath, "utf-8"));
    const { proof, publicSignals } = await snarkjs.groth16.prove(
      pkeyPath,
      wtnsPath,
    );
    const verificationSamples: number[] = [];

    await snarkjs.groth16.verify(vkey, publicSignals, proof); // Warm-up

    for (let i = 0; i < NUM_SAMPLES; i++) {
      const start = performance.now();
      await snarkjs.groth16.verify(vkey, publicSignals, proof);
      verificationSamples.push(performance.now() - start);
    }
    const proofVerificationTime = calculateStats(verificationSamples);
    console.log(
      `  Proof Verification: ${proofVerificationTime.avg.toFixed(2)} ms`,
    );

    return {
      circuit: circuitName,
      constraints,
      witnessGenerationTime,
      proofGenerationTime,
      proofVerificationTime,
      r1csSize: statSync(r1csPath).size,
      wasmSize: statSync(wasmPath).size,
      provingKeySize: statSync(pkeyPath).size,
      verificationKeySize: statSync(vkeyPath).size,
    };
  }

  describe("Automated Circuit Performance Tests", () => {
    const typedCircuitsConfig = circuitsConfig as {
      [key: string]: LocalCircuitConfig;
    };

    for (const [circuitName, circuitConfig] of Object.entries(
      typedCircuitsConfig,
    )) {
      if (!circuitConfig.template) {
        continue;
      }

      describe(`Benchmark: ${circuitName}`, function () {
        before(function () {
          skipIfMissing(this, circuitName);
        });

        it("should run and record performance metrics", async () => {
          const sampleInputs = await generateSampleInputs(circuitName);
          const result = await benchmarkCircuit(
            circuitName,
            circuitConfig,
            sampleInputs,
          );
          benchmarkResults.push(result);
          expect(result.constraints).to.be.greaterThan(0);
        });
      });
    }
  });
});
