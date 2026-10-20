#!/usr/bin/env node
/**
 * Regenerates DEFAULT_CIRCUIT_MANIFEST (src/constant/CircuitArtifacts.ts) from
 * a pinned IPFS circuit-artifacts bundle.
 *
 * For every artifact this script downloads the bytes once and derives both
 * manifest values from that single response: the sha256 digest from the body,
 * and the file-level CID from the gateway's X-Ipfs-Roots header (the last CID
 * in the header is the terminal file node). Deriving both from the same bytes
 * is the point of the script — the manifest digests are trust anchors, and
 * collecting CIDs and digests from different sources is how a manifest ends
 * up with digests that match no real file.
 *
 * The bundle CIDs are dag-pb, so the SDK cannot verify downloaded bytes
 * against the CID alone (see IpfsCircuitArtifacts.verifyArtifactContent).
 * That means this script trusts the gateway it downloads from. Run it against
 * a gateway you operate, or pass --cross-check to download every artifact
 * from a second independent gateway and require identical digests.
 *
 * Usage:
 *   node packages/core-sdk/scripts/generate-circuit-manifest.mjs [options]
 *
 * Options:
 *   --root <cid>        Bundle root directory CID. Default: the bundle
 *                       referenced by DEFAULT_CIRCUIT_MANIFEST.
 *   --gateways <urls>   Comma-separated gateway base URLs, tried in order.
 *   --cross-check       Re-download each artifact from the next gateway in
 *                       the list and fail on any digest mismatch.
 *   --circuits <names>  Comma-separated subset (e.g. deposit,transact_3x1).
 *
 * Output: the DEFAULT_CIRCUIT_MANIFEST object literal on stdout, ready to
 * paste into src/constant/CircuitArtifacts.ts. Progress goes to stderr.
 */

import { createHash } from "node:crypto";

const DEFAULT_ROOT = "QmWPCQmvkJMtFEyQ94MU2CFniH6u1sbq1AQYDjj4HFpWDX";
// ipfs.io times out on the larger proving keys; these two serve them reliably.
const DEFAULT_GATEWAYS = ["https://dweb.link", "https://gateway.pinata.cloud"];
const MAX_ATTEMPTS_PER_GATEWAY = 3;
const FETCH_TIMEOUT_MS = 300_000;
const CONCURRENCY = 3;

function parseArgs(argv) {
    const args = { root: DEFAULT_ROOT, gateways: DEFAULT_GATEWAYS, crossCheck: false, circuits: null };
    for (let i = 2; i < argv.length; i++) {
        switch (argv[i]) {
            case "--root":
                args.root = argv[++i];
                break;
            case "--gateways":
                args.gateways = argv[++i].split(",").map((u) => u.replace(/\/$/, ""));
                break;
            case "--cross-check":
                args.crossCheck = true;
                break;
            case "--circuits":
                args.circuits = argv[++i].split(",");
                break;
            default:
                throw new Error(`Unknown option: ${argv[i]}`);
        }
    }
    if (args.crossCheck && args.gateways.length < 2) {
        throw new Error("--cross-check needs at least two gateways");
    }
    return args;
}

function circuitNames() {
    const names = ["deposit", "ragequit"];
    for (let n = 1; n <= 5; n++) {
        for (let m = 1; m <= 5; m++) {
            names.push(`transact_${n}x${m}`);
        }
    }
    return names;
}

function artifactPaths(circuit) {
    return {
        wasm: `${circuit}/${circuit}_js/${circuit}.wasm`,
        provingKey: `${circuit}/groth16_pkey.zkey`,
        verificationKey: `${circuit}/groth16_vkey.json`,
    };
}

/**
 * Downloads one artifact through one gateway. Returns the body sha256 and the
 * file-level CID taken from X-Ipfs-Roots.
 *
 * Gateways sometimes answer 200 with their own error text in the body when
 * the backing node cannot retrieve the content in time. A response without an
 * X-Ipfs-Roots header is treated as such a failure — a real gateway response
 * for IPFS content always carries the resolution path.
 */
async function fetchArtifact(gateway, root, path) {
    const url = `${gateway}/ipfs/${root}/${path}`;
    const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${url}`);
    }
    const roots = res.headers.get("x-ipfs-roots");
    if (!roots) {
        throw new Error(`No X-Ipfs-Roots header from ${url} — gateway error body, not content`);
    }
    const cid = roots.split(",").at(-1).trim();
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) {
        throw new Error(`Empty body from ${url}`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { cid, sha256, size: bytes.length, gateway };
}

async function fetchWithFallback(gateways, root, path, stage) {
    const errors = [];
    for (const gateway of gateways) {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_GATEWAY; attempt++) {
            try {
                return await fetchArtifact(gateway, root, path);
            } catch (error) {
                errors.push(`${gateway} (attempt ${attempt}): ${error.message}`);
                await new Promise((r) => setTimeout(r, 2000 * attempt));
            }
        }
    }
    throw new Error(`${stage}: all gateways failed for ${path}:\n  ${errors.join("\n  ")}`);
}

async function processCircuit(args, circuit) {
    const entry = {};
    for (const [kind, path] of Object.entries(artifactPaths(circuit))) {
        const primary = await fetchWithFallback(args.gateways, args.root, path, "primary download");
        if (args.crossCheck) {
            // The cross-check must not hit the gateway that served the primary
            // download — agreement between two responses of the same gateway
            // proves nothing.
            const others = args.gateways.filter((g) => g !== primary.gateway);
            const second = await fetchWithFallback(others, args.root, path, "cross-check download");
            if (second.sha256 !== primary.sha256 || second.cid !== primary.cid) {
                throw new Error(
                    `Cross-check mismatch for ${path}: ` +
                        `${primary.sha256} (cid ${primary.cid}) vs ${second.sha256} (cid ${second.cid})`,
                );
            }
        }
        entry[kind] = primary.cid;
        entry[`${kind}Sha256`] = primary.sha256;
        process.stderr.write(`  ${circuit} ${kind}: ${primary.cid} sha256=${primary.sha256} (${primary.size} bytes)\n`);
    }
    return entry;
}

function renderManifest(manifest) {
    const lines = ["export const DEFAULT_CIRCUIT_MANIFEST: CircuitManifest = {"];
    for (const [circuit, entry] of Object.entries(manifest)) {
        lines.push(`    ${circuit}: {`);
        for (const kind of ["wasm", "provingKey", "verificationKey"]) {
            lines.push(`        ${kind}: "${entry[kind]}",`);
            lines.push(`        ${kind}Sha256: "${entry[`${kind}Sha256`]}",`);
        }
        lines.push("    },");
    }
    lines.push("};");
    return lines.join("\n");
}

async function main() {
    const args = parseArgs(process.argv);
    const names = args.circuits ?? circuitNames();
    process.stderr.write(`Bundle root: ${args.root}\nGateways: ${args.gateways.join(", ")}\n`);
    process.stderr.write(`Circuits: ${names.length}, cross-check: ${args.crossCheck}\n\n`);

    const manifest = {};
    const queue = [...names];
    const failures = [];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
            try {
                manifest[name] = await processCircuit(args, name);
            } catch (error) {
                failures.push(`${name}: ${error.message}`);
            }
        }
    });
    await Promise.all(workers);

    if (failures.length > 0) {
        process.stderr.write(`\nFAILED — no manifest emitted:\n${failures.join("\n")}\n`);
        process.exit(1);
    }
    // Emit in canonical circuit order regardless of completion order.
    const ordered = {};
    for (const name of names) {
        ordered[name] = manifest[name];
    }
    process.stdout.write(renderManifest(ordered) + "\n");
}

await main();
