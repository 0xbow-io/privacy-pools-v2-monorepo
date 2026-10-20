/**
 * PRIVACY POOLS V2 - PROOF FIXTURE GENERATOR
 *
 * Generates static JSON proof fixtures for offline/CI use in Foundry unit tests.
 * These fixtures are loaded via `vm.readFile()` in contract unit tests.
 *
 * This script is NOT used by contract integration/E2E tests. Those use the FFI
 * proof generators in `packages/contracts/test/helper/*.mjs` which generate
 * proofs on-the-fly with caller-provided inputs via Foundry's `vm.ffi()`.
 *
 * Prerequisites: the committed build artifacts (wasm + ceremony keys) are checked out.
 *   git lfs pull --include='packages/circuits/build/**'
 *
 * Usage:
 *   pnpm generate:proof deposit
 *   pnpm generate:proof transact_2x2
 *   pnpm generate:proof ragequit
 *   pnpm generate:proof --all
 *   pnpm generate:proof deposit --out ../contracts/test/fixtures/proofs/
 */

import * as path from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
import * as snarkjs from "snarkjs";

import {
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
} from "../test/common/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CIRCUITS_ROOT = path.join(__dirname, "..");
const BUILD_DIR = path.join(CIRCUITS_ROOT, "build");
const DEFAULT_OUTPUT_DIR = path.join(CIRCUITS_ROOT, "proofs");

// ============================================================================
// PROOF GENERATION
// ============================================================================

function getBuildPaths(circuitName: string) {
  const buildDir = path.join(BUILD_DIR, circuitName);
  return {
    buildDir,
    wasmPath: path.join(buildDir, `${circuitName}_js`, `${circuitName}.wasm`),
    pkeyPath: path.join(buildDir, "groth16_pkey.zkey"),
    vkeyPath: path.join(buildDir, "groth16_vkey.json"),
  };
}

function checkBuildArtifacts(circuitName: string): void {
  const paths = getBuildPaths(circuitName);
  const missing: string[] = [];

  if (!existsSync(paths.wasmPath)) missing.push("WASM");
  if (!existsSync(paths.pkeyPath)) missing.push("proving key");
  if (!existsSync(paths.vkeyPath)) missing.push("verification key");

  if (missing.length > 0) {
    throw new Error(
      `Missing build artifacts for ${circuitName}: ${missing.join(", ")}.\n` +
        `The artifacts are committed via Git LFS. Run: git lfs pull --include='packages/circuits/build/**'`,
    );
  }
}

async function generateProof(
  circuitName: string,
  inputs: Record<string, any>,
): Promise<{ proof: any; publicSignals: string[] }> {
  const paths = getBuildPaths(circuitName);

  // Generate witness
  const WitnessCalculator = require("circom_tester/wasm/witness_calculator");
  const wasmBuffer = readFileSync(paths.wasmPath);
  const witnessCalculator = await WitnessCalculator(wasmBuffer);
  const witnessBuffer = await witnessCalculator.calculateWTNSBin(inputs, 0);

  const wtnsPath = path.join(paths.buildDir, "proof_witness.wtns");
  writeFileSync(wtnsPath, Buffer.from(witnessBuffer));

  // Generate proof
  const { proof, publicSignals } = await snarkjs.groth16.prove(
    paths.pkeyPath,
    wtnsPath,
  );

  // Verify locally
  const vkey = JSON.parse(readFileSync(paths.vkeyPath, "utf-8"));
  const isValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  if (!isValid) {
    throw new Error(`Proof verification failed for ${circuitName}`);
  }

  return { proof, publicSignals };
}

async function formatForSolidity(
  proof: any,
  publicSignals: string[],
): Promise<{
  pA: [string, string];
  pB: [[string, string], [string, string]];
  pC: [string, string];
  pubSignals: string[];
}> {
  const calldataStr = await snarkjs.groth16.exportSolidityCallData(
    proof,
    publicSignals,
  );
  const parsed = JSON.parse(`[${calldataStr}]`);
  return {
    pA: parsed[0] as [string, string],
    pB: parsed[1] as [[string, string], [string, string]],
    pC: parsed[2] as [string, string],
    pubSignals: parsed[3] as string[],
  };
}

// Default circuits to generate when using --all
const DEFAULT_CIRCUITS = ["deposit", "transact_1x1", "transact_2x2", "ragequit"];

// Read tree depths from circuits.json
const circuitsConfig = JSON.parse(
  readFileSync(path.join(CIRCUITS_ROOT, "circuits.json"), "utf-8"),
);

const transactConfig = circuitsConfig["transact_1x1"];
const ragequitConfig = circuitsConfig["ragequit"];

// Transact params: [nInputs, mOutputs, stateMaxDepth, keystoreMaxDepth, aspMaxDepth]
const STATE_MAX_DEPTH = transactConfig?.params?.[2] ?? 32;
const KEYSTORE_MAX_DEPTH = transactConfig?.params?.[3] ?? 32;
const ASSOCIATION_SET_MAX_DEPTH = transactConfig?.params?.[4] ?? 32;
// Ragequit params: [keystoreDepth]
const RAGEQUIT_KEYSTORE_DEPTH = ragequitConfig?.params?.[0] ?? 32;

// ============================================================================
// SAMPLE INPUT GENERATORS
// ============================================================================
// Adapted from test/benchmark.test.ts — generates valid circuit inputs
// with synthetic Merkle trees for proof generation.

async function generateDepositInputs(): Promise<Record<string, any>> {
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
    noteAddressHash,
    depositSecret,
  };
}

async function generateTransactInputs(
  nInputs: number,
  mOutputs: number,
): Promise<Record<string, any>> {
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

  // Setup input notes
  const noteSecrets: bigint[] = [];
  const inputValues: bigint[] = [];
  const inputLabels: bigint[] = [];
  const inputCommitments: bigint[] = [];
  const timestamps: bigint[] = [];

  const baseValue = BigInt(1000000);
  const totalValue = baseValue * BigInt(nInputs);
  const valuePerInput = baseValue;

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

    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    timestamps.push(timestamp);
  }

  // Build state tree with timestamped leaves
  const timestampedLeaves: bigint[] = [];
  for (let i = 0; i < nInputs; i++) {
    const timestampedLeaf = await poseidon([
      COMMITMENT_LEAF_TAG,
      inputCommitments[i],
      timestamps[i],
    ]);
    timestampedLeaves.push(timestampedLeaf);
  }

  // No power-of-2 padding: per-input depths handle variable-depth LeanIMT proofs
  const stateTree = await createTree(timestampedLeaves);

  // Setup ASP tree with label hash
  const labelHash = await calculateLabelHash(label);
  const associationSetTree = await createTree([labelHash]);
  const associationSetProof = associationSetTree.generateProof(0);

  // Setup output notes — ensure value conservation
  const outputNoteAddressHashes: bigint[] = [];
  const outputValues: bigint[] = [];
  const outputLabels: bigint[] = [];

  const amountOut = BigInt(0); // Pure transfer
  const remainingValue = totalValue - amountOut;
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

  // Build association set proofs
  const associationSetSiblings: bigint[][] = [];
  const associationSetLeafIndices: bigint[] = [];
  const associationSetTreeDepths: bigint[] = [];

  for (let i = 0; i < nInputs; i++) {
    associationSetSiblings.push(
      padSiblings(associationSetProof.siblings, ASSOCIATION_SET_MAX_DEPTH),
    );
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

async function generateRagequitInputs(): Promise<Record<string, any>> {
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
    keystoreSiblings: padSiblings(
      keystoreProof.siblings,
      RAGEQUIT_KEYSTORE_DEPTH,
    ),
    keystoreTreeDepth: BigInt(keystoreTree.depth),
  };
}

async function generateSampleInputs(
  circuitName: string,
): Promise<Record<string, any>> {
  if (circuitName === "deposit") {
    return generateDepositInputs();
  }

  if (circuitName === "ragequit") {
    return generateRagequitInputs();
  }

  const transactMatch = circuitName.match(/transact_(\d+)x(\d+)/);
  if (transactMatch) {
    const nInputs = parseInt(transactMatch[1]);
    const mOutputs = parseInt(transactMatch[2]);
    return generateTransactInputs(nInputs, mOutputs);
  }

  throw new Error(`Unknown circuit: ${circuitName}`);
}

// ============================================================================
// BIGINT JSON SERIALIZATION
// ============================================================================

function bigintToHex(value: bigint): string {
  return "0x" + value.toString(16);
}

function serializeBigints(obj: any): any {
  if (typeof obj === "bigint") {
    return bigintToHex(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(serializeBigints);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = serializeBigints(value);
    }
    return result;
  }
  return obj;
}

// ============================================================================
// PUBLIC INPUT NAME MAPPING
// ============================================================================

function getPublicInputNames(circuitName: string): string[] {
  const config = circuitsConfig[circuitName];
  return config?.pubs ?? [];
}

function mapPublicInputs(
  circuitName: string,
  publicSignals: string[],
): Record<string, string> {
  const pubNames = getPublicInputNames(circuitName);
  const result: Record<string, string> = {};

  // Public inputs come first in the signals array
  for (let i = 0; i < pubNames.length; i++) {
    if (i < publicSignals.length) {
      result[pubNames[i]] = publicSignals[i];
    }
  }

  // Remaining signals are outputs
  const outputSignals = publicSignals.slice(pubNames.length);
  if (circuitName === "deposit") {
    if (outputSignals.length > 0) result["outputCommitment"] = outputSignals[0];
  } else if (circuitName === "ragequit") {
    if (outputSignals.length > 0) result["nullifierHash"] = outputSignals[0];
    if (outputSignals.length > 1) result["commitment"] = outputSignals[1];
  } else if (circuitName.startsWith("transact_")) {
    const match = circuitName.match(/transact_(\d+)x(\d+)/);
    if (match) {
      const nInputs = parseInt(match[1]);
      const mOutputs = parseInt(match[2]);
      for (let i = 0; i < nInputs && i < outputSignals.length; i++) {
        result[`nullifierHash_${i}`] = outputSignals[i];
      }
      for (
        let i = 0;
        i < mOutputs && nInputs + i < outputSignals.length;
        i++
      ) {
        result[`outputCommitment_${i}`] = outputSignals[nInputs + i];
      }
    }
  }

  return result;
}

// ============================================================================
// FIXTURE GENERATION
// ============================================================================

interface ProofFixture {
  circuit: string;
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
  };
  publicSignals: string[];
  solidityCalldata: {
    pA: [string, string];
    pB: [[string, string], [string, string]];
    pC: [string, string];
    pubSignals: string[];
  };
  publicInputs: Record<string, string>;
}

async function generateFixture(circuitName: string): Promise<ProofFixture> {
  console.log(`\nGenerating proof for ${circuitName}...`);

  // Check build artifacts exist
  checkBuildArtifacts(circuitName);

  // Generate sample inputs
  console.log(`  Generating sample inputs...`);
  const inputs = await generateSampleInputs(circuitName);

  // Generate proof
  console.log(`  Generating proof...`);
  const { proof, publicSignals } = await generateProof(circuitName, inputs);
  console.log(`  Proof verified successfully.`);

  // Format for Solidity
  console.log(`  Formatting for Solidity...`);
  const solidityCalldata = await formatForSolidity(proof, publicSignals);

  // Map public input names
  const publicInputs = mapPublicInputs(circuitName, publicSignals);

  return {
    circuit: circuitName,
    proof: {
      pi_a: proof.pi_a,
      pi_b: proof.pi_b,
      pi_c: proof.pi_c,
    },
    publicSignals,
    solidityCalldata,
    publicInputs,
  };
}

function writeFixture(
  fixture: ProofFixture,
  outputDir: string,
): void {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, `${fixture.circuit}.json`);
  writeFileSync(outputPath, JSON.stringify(fixture, null, 2));
  console.log(`  Written to: ${outputPath}`);
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(): { circuits: string[]; outputDir: string } {
  const args = process.argv.slice(2);
  let circuits: string[] = [];
  let outputDir = DEFAULT_OUTPUT_DIR;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--all") {
      circuits = [...DEFAULT_CIRCUITS];
    } else if (arg === "--out" && i + 1 < args.length) {
      outputDir = path.resolve(args[++i]);
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith("--")) {
      circuits.push(arg);
    }
  }

  if (circuits.length === 0) {
    printUsage();
    process.exit(1);
  }

  return { circuits, outputDir };
}

function printUsage(): void {
  console.log(`
Usage: pnpm generate:proof <circuit> [options]

Circuits:
  deposit              Generate deposit proof fixture
  transact_NxM         Generate transact proof fixture (e.g., transact_2x2)
  ragequit             Generate ragequit proof fixture

Options:
  --all                Generate fixtures for default circuits
                       (deposit, transact_1x1, transact_2x2, ragequit)
  --out <dir>          Output directory (default: ./proofs/)
  --help, -h           Show this help message

Examples:
  pnpm generate:proof deposit
  pnpm generate:proof transact_2x2 --out ../contracts/test/fixtures/proofs/
  pnpm generate:proof --all
  pnpm generate:proof deposit ragequit --out ./my-fixtures/
`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const { circuits, outputDir } = parseArgs();

  console.log("=".repeat(60));
  console.log("Privacy Pools V2 - Proof Fixture Generator");
  console.log("=".repeat(60));
  console.log(`Circuits: ${circuits.join(", ")}`);
  console.log(`Output:   ${outputDir}`);

  // Validate all circuits exist in config before starting
  for (const circuitName of circuits) {
    if (!circuitsConfig[circuitName]) {
      console.error(
        `\nError: Unknown circuit "${circuitName}".`,
      );
      console.error(
        `Available circuits: ${Object.keys(circuitsConfig).join(", ")}`,
      );
      process.exit(1);
    }
  }

  const results: { circuit: string; success: boolean; error?: string }[] = [];

  for (const circuitName of circuits) {
    try {
      const fixture = await generateFixture(circuitName);
      writeFixture(fixture, outputDir);
      results.push({ circuit: circuitName, success: true });
    } catch (error: any) {
      console.error(`\nError generating ${circuitName}: ${error.message}`);
      results.push({
        circuit: circuitName,
        success: false,
        error: error.message,
      });
    }
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));

  for (const result of results) {
    const status = result.success ? "OK" : "FAILED";
    console.log(`  ${result.circuit}: ${status}${result.error ? ` (${result.error})` : ""}`);
  }

  const failedCount = results.filter((r) => !r.success).length;
  if (failedCount > 0) {
    console.error(`\n${failedCount} fixture(s) failed.`);
    process.exit(1);
  }

  console.log(`\nAll ${results.length} fixture(s) generated successfully.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
