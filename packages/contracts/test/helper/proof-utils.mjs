/**
 * Shared proof generation utilities for FFI generators.
 *
 * Extracts common logic (stdout suppression, witness calculation, Groth16
 * proving/verification, Solidity calldata export) so each circuit-specific
 * generator only contains its input parsing and ABI encoding.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const snarkjs = await import("snarkjs");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CIRCUITS_BUILD = join(__dirname, "..", "..", "..", "circuits", "build");

// ── Stdout suppression ──────────────────────────────────────────────

/**
 * Wraps an async function so that all stdout/stderr writes are suppressed
 * during its execution. This is critical for FFI mode where only the final
 * ABI-encoded hex must appear on stdout.
 */
export function withSilentStdout(fn) {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  return async (...args) => {
    process.stdout.write = () => true;
    process.stderr.write = () => true;

    try {
      const result = await fn(...args);
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      return result;
    } catch (error) {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      throw error;
    }
  };
}

// ── Input validation ────────────────────────────────────────────────

/**
 * Recursively validates that all leaf values in the parsed JSON object are
 * strings. This catches accidental numeric literals in the input JSON which
 * would silently lose precision for large field elements.
 */
export function validateStringInputs(obj, path = "") {
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => validateStringInputs(item, `${path}[${i}]`));
  } else if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      validateStringInputs(value, path ? `${path}.${key}` : key);
    }
  } else if (typeof obj === "number") {
    throw new Error(
      `Input value at "${path}" is a number (${obj}). All values must be strings to avoid precision loss.`,
    );
  }
}

// ── Proof generation ────────────────────────────────────────────────

/**
 * Full Groth16 proof pipeline: load artifacts -> witness -> prove -> verify.
 *
 * @param {string} circuitName  Build directory name (e.g. "deposit", "transact_2x2")
 * @param {object} inputs       Circuit inputs (BigInt values)
 * @param {object} [opts]
 * @param {boolean} [opts.verify=true]  Whether to verify the proof after generation.
 *   Verification uses the pairing check on the verification key and is ~1000x faster
 *   than proving, so the overhead is negligible. Enabled by default as a safety net.
 * @returns {Promise<{proof: object, publicSignals: string[]}>}
 */
export async function generateProof(circuitName, inputs, opts = {}) {
  const { verify = true } = opts;

  const buildDir = join(CIRCUITS_BUILD, circuitName);
  const wasmPath = join(buildDir, `${circuitName}_js`, `${circuitName}.wasm`);
  const pkeyPath = join(buildDir, "groth16_pkey.zkey");
  const vkeyPath = join(buildDir, "groth16_vkey.json");

  for (const [name, p] of [
    ["WASM", wasmPath],
    ["proving key", pkeyPath],
    ["verification key", vkeyPath],
  ]) {
    if (!existsSync(p)) {
      throw new Error(
        `Missing ${name} for ${circuitName}. The artifacts are committed via Git LFS. Run: git lfs pull --include='packages/circuits/build/**'`,
      );
    }
  }

  // Generate witness
  const WitnessCalculator = require("circom_tester/wasm/witness_calculator");
  const wasmBuffer = readFileSync(wasmPath);
  const witnessCalculator = await WitnessCalculator(wasmBuffer);
  const witnessBuffer = await witnessCalculator.calculateWTNSBin(inputs, 0);

  // Use a per-process unique path to avoid races when Foundry runs tests in parallel.
  // Each test spawns its own node process (its own PID), so this is safe.
  const wtnsPath = join(buildDir, `proof_witness_${process.pid}.wtns`);
  writeFileSync(wtnsPath, Buffer.from(witnessBuffer));

  // Generate proof
  let proof, publicSignals;
  try {
    ({ proof, publicSignals } = await snarkjs.groth16.prove(pkeyPath, wtnsPath));
  } finally {
    try { unlinkSync(wtnsPath); } catch (_) {}
  }

  // Verify proof (enabled by default — ~1000x faster than proving, negligible overhead)
  if (verify) {
    const vkey = JSON.parse(readFileSync(vkeyPath, "utf-8"));
    const isValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    if (!isValid) throw new Error("Proof verification failed");
  }

  return { proof, publicSignals };
}

// ── Solidity calldata export ────────────────────────────────────────

/**
 * Export proof + public signals as Solidity-compatible calldata components.
 * Returns { pA, pB, pC, pubSignals } with all values as BigInts.
 */
export async function exportSolidityCalldata(proof, publicSignals) {
  const calldataStr = await snarkjs.groth16.exportSolidityCallData(
    proof,
    publicSignals,
  );
  const [pA, pB, pC, pubSignals] = JSON.parse(`[${calldataStr}]`);

  return {
    pA: pA.map(BigInt),
    pB: pB.map((row) => row.map(BigInt)),
    pC: pC.map(BigInt),
    pubSignals: pubSignals.map(BigInt),
  };
}
