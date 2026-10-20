import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Hex } from "@privacy-pools-v2/evm-sdk";
import { FileStorageService, NoteStorageAdapter } from "@privacy-pools-v2/evm-sdk";
import { privateKeyToAccount } from "viem/accounts";

import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";

/**
 * Verifies that the SDK auto-persists NoteManager state to disk:
 *   - after `discoverNotes`, the persisted file contains every note returned
 *     in-memory by `exportAccount`, with matching commitment / status / value
 *     / createdAtBlock — and the syncCursor advanced past block 0.
 *
 * The verification reads the storage file via an INDEPENDENT
 * `NoteStorageAdapter` (not the one inside Bob's session) so we exercise
 * the actual file-write contract, not just in-memory state.
 */
const STORAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "note-discovery");
const STORAGE_FILE = "note-discovery-storage-test";

async function main(): Promise<void> {
    // Independent reader — same FileStorageService config Bob's session uses.
    // The adapter key now includes the owner address (audit M-5), so we must
    // derive Bob's address here too or the reader looks at a different slot.
    const bobAddress = privateKeyToAccount(config.bob.privateKey as `0x${string}`).address as Hex;
    const storageReader = new NoteStorageAdapter(
        config.chainId,
        new FileStorageService({ dirPath: STORAGE_DIR, filename: STORAGE_FILE }),
        bobAddress,
    );
    await storageReader.clearState();

    // Bob's session, file-backed.
    const bob = await createBobPoolSession({
        persistentStorage: { type: "file", dirPath: STORAGE_DIR, filename: STORAGE_FILE },
    });

    // Run discovery — auto-flushes NoteManager state at the end.
    console.log("Bob discovers notes...");
    const discovered = await bob.poolSession.discoverNotes();
    console.log(`  in-memory: ${discovered.length} note(s)`);

    // Read persisted state via the independent reader.
    const persisted = await storageReader.getState();
    if (!persisted) {
        throw new Error(
            "Post-condition violated: storage file is empty after discoverNotes. " +
                "→ NoteDiscoveryService should call NoteManager.flush() at the end of a scan.",
        );
    }
    console.log(`  on-disk:   ${persisted.notes.length} note(s)  syncCursor=${persisted.syncCursor}`);

    // Counts should match.
    if (persisted.notes.length !== discovered.length) {
        throw new Error(
            `Post-condition violated: in-memory has ${discovered.length} notes, on-disk has ${persisted.notes.length}.`,
        );
    }

    // syncCursor must have advanced past genesis.
    if (BigInt(persisted.syncCursor) === 0n) {
        throw new Error(
            "Post-condition violated: persisted syncCursor is 0x0 after discovery. " +
                "→ Subsequent discovery would re-scan from genesis on every run.",
        );
    }

    // Every in-memory note must round-trip identically through the file.
    const persistedByCommitment = new Map(persisted.notes.map((n) => [n.commitment.toLowerCase(), n]));
    for (const note of discovered) {
        const onDisk = persistedByCommitment.get(note.commitment.toLowerCase());
        if (!onDisk) {
            throw new Error(`Note ${note.commitment} present in-memory but missing on-disk.`);
        }
        if (onDisk.status !== note.status) {
            throw new Error(
                `Note ${note.commitment}: status drift (memory=${note.status}, disk=${onDisk.status}).`,
            );
        }
        if (onDisk.value !== note.value) {
            throw new Error(`Note ${note.commitment}: value drift.`);
        }
        if (onDisk.createdAtBlock !== note.createdAtBlock) {
            throw new Error(`Note ${note.commitment}: createdAtBlock drift.`);
        }
        if (onDisk.label !== note.label) {
            throw new Error(`Note ${note.commitment}: label drift.`);
        }
    }
    console.log(`  ✓ all ${discovered.length} note(s) round-tripped through disk`);

    console.log("\n✓ noteDiscovery storage ok — discoverNotes auto-persists complete NoteManager state");
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
