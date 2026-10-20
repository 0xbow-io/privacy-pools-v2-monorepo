import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ICircuitArtifacts, LocalCircuitArtifactsConfig } from "../../internal.js";
import { CIRCUIT_NAME_PATTERN, CircuitArtifactLoadFailed } from "../../internal.js";

export class LocalCircuitArtifacts implements ICircuitArtifacts {
    private readonly baseDir: string;

    constructor(config: LocalCircuitArtifactsConfig) {
        this.baseDir = config.baseDir;
    }

    async getWasm(circuitName: string): Promise<Uint8Array> {
        this.assertSafeCircuitName(circuitName);
        const filePath = join(
            this.baseDir,
            circuitName,
            `${circuitName}_js`,
            `${circuitName}.wasm`,
        );
        const buffer = await readFile(filePath);
        return new Uint8Array(buffer);
    }

    async getProvingKey(circuitName: string): Promise<Uint8Array> {
        this.assertSafeCircuitName(circuitName);
        const filePath = join(this.baseDir, circuitName, "groth16_pkey.zkey");
        const buffer = await readFile(filePath);
        return new Uint8Array(buffer);
    }

    async getVerificationKey(circuitName: string): Promise<Uint8Array> {
        this.assertSafeCircuitName(circuitName);
        const filePath = join(this.baseDir, circuitName, "groth16_vkey.json");
        const buffer = await readFile(filePath);
        return new Uint8Array(buffer);
    }

    /**
     * Rejects circuit names that aren't a bare lowercase-alphanumeric slug.
     * `circuitName` is interpolated into a filesystem path, so a `..`-bearing
     * or slash-bearing name would escape `baseDir` and read arbitrary host
     * files. The allowlist disallows `.`, `/`, `\`, and null bytes, making
     * traversal structurally impossible.
     *
     * @throws {CircuitArtifactLoadFailed} If the name contains anything outside `[a-z0-9_]`.
     */
    private assertSafeCircuitName(circuitName: string): void {
        if (!CIRCUIT_NAME_PATTERN.test(circuitName)) {
            throw new CircuitArtifactLoadFailed(
                `Invalid circuit name "${circuitName}": must match ${CIRCUIT_NAME_PATTERN}`,
            );
        }
    }
}
