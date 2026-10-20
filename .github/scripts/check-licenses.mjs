#!/usr/bin/env node
// Checks that every tracked file carries the license of the directory it lives in (see the root LICENSE
// map): SPDX headers, package.json / Cargo.toml license fields, per-directory LICENSE texts, and that no
// non-GPL Solidity file imports the GPL-3.0 snarkjs verifier sources. Exits 1 and lists every violation.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const BUSL = { name: "BUSL-1.1", spdx: /^BUSL-1\.1$/, manifest: "BUSL-1.1", text: "Business Source License 1.1" };
const GPL = {
    name: "GPL-3.0-or-later",
    // The snarkjs-generated verifiers carry the deprecated `GPL-3.0` id; any GPL-3.0 form is consistent.
    spdx: /^GPL-3\.0(-only|-or-later)?$/,
    manifest: "GPL-3.0-or-later",
    text: "GNU GENERAL PUBLIC LICENSE",
};
const MIT = { name: "MIT", spdx: /^MIT$/, manifest: "MIT", text: "MIT License" };

// First match wins. Mirrors the root LICENSE map.
const RULES = [
    // GPL manifests that compile the snarkjs verifiers as standalone artifacts (see NOTICE).
    { test: (f) => /^packages\/(contracts|swaps\/contracts)\/src\/verifiers\/VerifierArtifacts\.sol$/.test(f), license: GPL },
    { test: (f) => f.startsWith("packages/circuits/"), license: GPL },
    { test: (f) => f.startsWith("packages/relayer/"), license: GPL },
    { test: (f) => /^packages\/(contracts|contracts-stellar|swaps)\//.test(f), license: BUSL },
    { test: () => true, license: MIT },
];
const expectedFor = (file) => RULES.find((r) => r.test(file)).license;

// Directories with their own full-text LICENSE file.
const LICENSE_DIRS = [
    "packages/contracts",
    "packages/contracts-stellar",
    "packages/swaps",
    "packages/circuits",
    "packages/relayer",
    "packages/core-sdk",
    "packages/evm-sdk",
    "packages/stellar-sdk",
    "packages/mock-asp",
    "packages/e2e-suite",
    "apps",
];

const SOURCE_EXT = /\.(sol|rs|ts|tsx|js|mjs|cjs|circom|py|sh)$/;
const SPDX = /SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/g;
// Matches `import "p";`, `import "p" as X;`, `import {X} from "p";` and `import * as X from "p";`.
const GPL_VERIFIER_IMPORT = /\bimport\s+(?:[^;'"]*\bfrom\s+)?['"](verifiers\/[^'"]*|[^'"]*circuits\/build\/[^'"]*)['"]/;

const errors = [];
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf-8",
})
    .split("\0")
    .filter(Boolean);

const read = (file) => {
    const path = join(ROOT, file);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return undefined;
    return readFileSync(path, "utf-8");
};

for (const file of files) {
    if (!SOURCE_EXT.test(file)) continue;
    const content = read(file);
    if (content === undefined) continue;
    const expected = expectedFor(file);
    // Every occurrence counts, so code generators that emit SPDX headers are checked too.
    for (const [, id] of content.matchAll(SPDX)) {
        if (!expected.spdx.test(id)) errors.push(`${file}: SPDX ${id}, expected ${expected.name}`);
    }
    if (file.endsWith(".sol") && expected !== GPL && GPL_VERIFIER_IMPORT.test(content)) {
        errors.push(`${file}: ${expected.name} file imports GPL-3.0 verifier source (deploy it from its artifact instead)`);
    }
}

for (const file of files) {
    const isPackageJson = file.endsWith("package.json") && !file.includes("node_modules/");
    const isCargoWorkspace = file === "packages/contracts-stellar/Cargo.toml";
    if (!isPackageJson && !isCargoWorkspace) continue;
    const content = read(file);
    if (content === undefined) continue;
    if (file === "package.json") {
        const license = JSON.parse(content).license;
        if (license !== "SEE LICENSE IN LICENSE") errors.push(`${file}: license "${license}", expected "SEE LICENSE IN LICENSE"`);
        continue;
    }
    const license = isPackageJson ? JSON.parse(content).license : content.match(/^license\s*=\s*"([^"]+)"/m)?.[1];
    const expected = expectedFor(file);
    if (license !== expected.manifest) errors.push(`${file}: license "${license}", expected "${expected.manifest}"`);
}

const canonical = new Map();
for (const dir of LICENSE_DIRS) {
    const file = `${dir}/LICENSE`;
    const content = read(file);
    const expected = expectedFor(`${dir}/x`);
    if (content === undefined) {
        errors.push(`${file}: missing (expected ${expected.name} text)`);
        continue;
    }
    if (!content.trimStart().startsWith(expected.text)) errors.push(`${file}: not the ${expected.name} text`);
    // Copies of the same license must stay byte-identical (the BUSL parameters live in each copy).
    const first = canonical.get(expected.name);
    if (first === undefined) canonical.set(expected.name, { file, content });
    else if (first.content !== content) errors.push(`${file}: differs from ${first.file}`);
}

if (errors.length > 0) {
    console.error(`License check failed (${errors.length}):\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
}
console.log(`License check passed: ${files.length} files, ${LICENSE_DIRS.length} LICENSE texts.`);
