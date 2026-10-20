// Runs against the BUILT package (CI builds evm-sdk before its tests), because the
// bug it guards lived only in the bundle: every core-sdk value that evm-sdk passed
// through with `export *` was undefined in dist while the src-based tests passed.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const esmEntry = join(pkgDir, "dist", "index.js");
const cjsEntry = join(pkgDir, "dist", "index.cjs");
const built = existsSync(esmEntry) && existsSync(cjsEntry);

describe.skipIf(!built)("built evm-sdk re-exports core-sdk's runtime values", () => {
    it("every core-sdk runtime export is defined in the ESM and CJS builds", async () => {
        const core = (await import("@privacy-pools-v2/core-sdk")) as Record<string, unknown>;
        const esm = (await import(pathToFileURL(esmEntry).href)) as Record<string, unknown>;
        const cjs = createRequire(join(pkgDir, "package.json"))(cjsEntry) as Record<string, unknown>;
        const names = Object.keys(core).filter((n) => n !== "default" && core[n] !== undefined);
        expect(names.length).toBeGreaterThan(100);
        const missingEsm = names.filter((n) => esm[n] === undefined);
        const missingCjs = names.filter((n) => cjs[n] === undefined);
        expect(missingEsm).toEqual([]);
        expect(missingCjs).toEqual([]);
    });

    it("the values reported missing in the original finding are there", async () => {
        const esm = (await import(pathToFileURL(esmEntry).href)) as Record<string, unknown>;
        for (const name of ["NoteStatus", "PoseidonHashService", "RPCInteractorBaseError", "CryptoService"]) {
            expect(esm[name], name).toBeDefined();
        }
    });
});
