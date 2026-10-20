import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { PoseidonHashService } from "@privacy-pools-v2/evm-sdk";
import type { AccountExport, Hash, Hex } from "@privacy-pools-v2/evm-sdk";

import { computeNewASPRoot, updateASPRootOnChain } from "../util/aspSimulator.js";
import { createBobPoolSession } from "../util/createBobPoolSession.js";

/**
 * Adds the label of a given commitment to the local ASP leaf set, computes
 * the new tree root, optionally pushes it on-chain (`--submit`), and writes
 * the updated set to `asp-leaves.json`.
 *
 * Used to simulate ASP approval for the cold-start flow without running the
 * full `runASPListener.ts`.
 *
 * CLI: `pnpm sample:computeAspRoot <commitment> [--submit]`
 */
async function main(): Promise<void> {
    const commitment = process.argv[2] as Hex | undefined;
    const submit = process.argv.includes("--submit");
    if (!commitment) {
        console.error("Usage: pnpm sample:computeAspRoot <commitment> [--submit]");
        process.exit(1);
    }

    console.log("=== Sample: computeASPRoot ===\n");

    // Find the note in Bob's session (so we can look up the label without
    // requiring the user to pass it on the command line).
    const bob = await createBobPoolSession();
    await bob.poolSession.discoverNotes();
    const account: AccountExport = await bob.poolSession.exportAccount();
    const note = account.notes.find(
        (n) => n.commitment.toLowerCase() === commitment.toLowerCase(),
    );
    if (!note) {
        throw new Error(
            `Commitment ${commitment} not found in Bob's discovered notes. ` +
                "Pass a commitment owned by Bob, or update the script to source the label elsewhere.",
        );
    }
    console.log(`commitment: ${note.commitment}`);
    console.log(`label:      ${note.label}\n`);

    const hashService = await PoseidonHashService.create();

    // Load existing leaves (if any) from the integrator-side input file.
    const aspLeavesPath = join(import.meta.dirname, "..", "..", "asp-leaves.json");
    let existingLeaves: Hash[] = [];
    let existingRoot: Hash | undefined;
    if (existsSync(aspLeavesPath)) {
        const data = JSON.parse(readFileSync(aspLeavesPath, "utf-8")) as {
            leaves: Hash[];
            root: Hash;
        };
        existingLeaves = data.leaves;
        existingRoot = data.root;
        console.log(`existing leaves: ${existingLeaves.length}, root: ${existingRoot}`);
    } else {
        console.log("no existing asp-leaves.json — starting empty");
    }

    const { newRoot, leaves, isNewLeaf } = await computeNewASPRoot(
        note.label,
        existingLeaves,
        hashService,
    );
    console.log(`new root:        ${newRoot}`);
    console.log(`new leaf added:  ${isNewLeaf}\n`);

    // Post-condition: root changes iff a new leaf was added.
    if (isNewLeaf && existingRoot && newRoot === existingRoot) {
        throw new Error(
            "Post-condition violated: root unchanged despite a new leaf. " +
                "→ MerkleService.generateMerkleProof either deduplicated unexpectedly or recomputed identically.",
        );
    }
    if (!isNewLeaf && existingRoot && newRoot !== existingRoot) {
        throw new Error(
            "Post-condition violated: root changed without a new leaf. " +
                "→ leaf-set ordering or tree height drifted.",
        );
    }

    writeFileSync(aspLeavesPath, JSON.stringify({ leaves, root: newRoot }, null, 2));
    console.log(`wrote ${aspLeavesPath}`);

    if (submit) {
        console.log("submitting updateASPRoot on-chain...");
        const { txHash } = await updateASPRootOnChain({ root: newRoot, rpcInteractor: bob.rpcInteractor });
        console.log(`  tx hash: ${txHash}`);
    } else {
        console.log("\n(pass --submit to call updateASPRoot on-chain via POSTMAN_PK)");
    }

    console.log("\n=== computeASPRoot complete (assertions passed) ===");
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
