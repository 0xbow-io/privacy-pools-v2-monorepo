import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CircuitArtifactLoadFailed, LocalCircuitArtifacts } from "../../../src/internal.js";

describe("LocalCircuitArtifacts", () => {
    let baseDir: string;
    let artifacts: LocalCircuitArtifacts;

    const WASM_BYTES = new Uint8Array([0xde, 0xad]);
    const PKEY_BYTES = new Uint8Array([0x01, 0x02]);
    const VKEY_BYTES = new Uint8Array([0x03, 0x04]);

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "local-circuit-artifacts-"));
        const depositDir = join(baseDir, "deposit");
        await mkdir(join(depositDir, "deposit_js"), { recursive: true });
        await writeFile(join(depositDir, "deposit_js", "deposit.wasm"), WASM_BYTES);
        await writeFile(join(depositDir, "groth16_pkey.zkey"), PKEY_BYTES);
        await writeFile(join(depositDir, "groth16_vkey.json"), VKEY_BYTES);

        artifacts = new LocalCircuitArtifacts({ baseDir });
    });

    afterAll(async () => {
        await rm(baseDir, { recursive: true, force: true });
    });

    describe("valid circuit names", () => {
        it("read WASM for a valid circuit name", async () => {
            const result = await artifacts.getWasm("deposit");
            expect(result).toEqual(WASM_BYTES);
        });

        it("read proving key for a valid circuit name", async () => {
            const result = await artifacts.getProvingKey("deposit");
            expect(result).toEqual(PKEY_BYTES);
        });

        it("read verification key for a valid circuit name", async () => {
            const result = await artifacts.getVerificationKey("deposit");
            expect(result).toEqual(VKEY_BYTES);
        });

        it("accept transact_NxM naming", () => {
            // No fixture on disk for this name — just assert it passes the
            // name guard (rejects with a non-CircuitArtifactLoadFailed fs
            // error, not the validation error).
            return artifacts.getWasm("transact_3x2").then(
                () => {
                    throw new Error("expected a filesystem read error");
                },
                (error: unknown) => {
                    expect(error).not.toBeInstanceOf(CircuitArtifactLoadFailed);
                },
            );
        });
    });

    describe("path traversal rejection", () => {
        const traversalNames = [
            "../escape",
            "../../etc/passwd",
            "deposit/../../../secret",
            "/abs/path",
            "deposit/nested",
            "..",
            "",
            "deposit\\windows",
            "dep.osit",
        ];

        for (const name of traversalNames) {
            it(`reject getWasm("${name}")`, async () => {
                await expect(artifacts.getWasm(name)).rejects.toThrow(CircuitArtifactLoadFailed);
            });

            it(`reject getProvingKey("${name}")`, async () => {
                await expect(artifacts.getProvingKey(name)).rejects.toThrow(
                    CircuitArtifactLoadFailed,
                );
            });

            it(`reject getVerificationKey("${name}")`, async () => {
                await expect(artifacts.getVerificationKey(name)).rejects.toThrow(
                    CircuitArtifactLoadFailed,
                );
            });
        }
    });
});
