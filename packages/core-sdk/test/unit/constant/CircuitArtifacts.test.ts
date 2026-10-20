import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_CIRCUIT_MANIFEST } from "../../../src/internal.js";

/**
 * Pins DEFAULT_CIRCUIT_MANIFEST to the circuit artifacts committed in
 * packages/circuits/build. The manifest digests are what
 * IpfsCircuitArtifacts trusts when verifying downloads, so a digest that
 * stops matching the repo's artifacts means proofs built from the pinned
 * bundle no longer correspond to the circuits in this monorepo — this test
 * makes that drift a CI failure instead of a runtime surprise.
 *
 * Regenerate the manifest with `pnpm generate:circuit-manifest` after
 * re-pinning a new bundle.
 */
const BUILD_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../circuits/build");

// node:crypto instead of @noble/hashes: the proving keys are tens of MB and
// the native hash keeps this suite fast.
const sha256File = (path: string): string =>
    createHash("sha256").update(readFileSync(path)).digest("hex");

const artifactPaths = (circuit: string): Record<string, string> => ({
    wasmSha256: join(BUILD_DIR, circuit, `${circuit}_js`, `${circuit}.wasm`),
    provingKeySha256: join(BUILD_DIR, circuit, "groth16_pkey.zkey"),
    verificationKeySha256: join(BUILD_DIR, circuit, "groth16_vkey.json"),
});

describe("DEFAULT_CIRCUIT_MANIFEST vs packages/circuits/build", () => {
    it("find the committed circuit build directory", () => {
        expect(existsSync(BUILD_DIR)).toBe(true);
    });

    for (const [circuit, entry] of Object.entries(DEFAULT_CIRCUIT_MANIFEST)) {
        it(`match repo artifacts for ${circuit}`, () => {
            for (const [digestKey, path] of Object.entries(artifactPaths(circuit))) {
                const pinned = entry[digestKey as keyof typeof entry];
                expect(existsSync(path), `missing local artifact: ${path}`).toBe(true);
                expect(
                    sha256File(path),
                    `${circuit}.${digestKey} no longer matches ${path} — ` +
                        "the pinned bundle and the repo's circuits have drifted; " +
                        "re-pin and run `pnpm generate:circuit-manifest`",
                ).toBe(pinned);
            }
        });
    }
});
