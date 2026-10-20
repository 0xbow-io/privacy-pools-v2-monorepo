import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    FileStorageService,
    NoteManager,
    NoteStatus,
    NoteStorageAdapter,
} from "@privacy-pools-v2/evm-sdk";
import type { Hash, Hex, Note } from "@privacy-pools-v2/evm-sdk";

/**
 * NoteManager file-based persistence demonstration (offline; no chain).
 *
 * 1. fresh manager — adds two notes, flushes to disk
 * 2. new manager — loads from disk, verifies notes round-tripped
 *
 * Asserts internally — clean exit means persistence works.
 */
const CHAIN_ID = 11155111;
const STORAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const ETH_TOKEN_ID = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;
// Demo-only owner address — pins the storage key to a stable slot so the
// "fresh manager → reload" round-trip in main() reads what it just wrote.
const DEMO_OWNER_ADDRESS = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF" as const;

function makeNote(overrides: Partial<Note> & Pick<Note, "commitment" | "label">): Note {
    return {
        noteAddressHash: "0x0" as Hex,
        value: "0x16345785d8a0000" as Hex,
        tokenId: ETH_TOKEN_ID,
        status: NoteStatus.INACTIVE,
        ownerAddress: "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF",
        noteSecret: "0xaabbccdd" as Hex,
        isOwned: true,
        createdAtBlock: "0x1" as Hex,
        spentAtBlock: null,
        txHash: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hash,
        ...overrides,
    };
}

const NOTE_A = makeNote({
    commitment: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hash,
    label: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
});
const NOTE_B = makeNote({
    commitment: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hash,
    label: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as Hex,
    value: "0x2c68af0bb140000" as Hex,
});

function makeManager(): { manager: NoteManager; adapter: NoteStorageAdapter } {
    const storage = new FileStorageService({ filename: "note-manager", dirPath: STORAGE_DIR });
    const adapter = new NoteStorageAdapter(CHAIN_ID, storage, DEMO_OWNER_ADDRESS);
    const manager = new NoteManager({}, { storageAdapter: adapter });
    return { manager, adapter };
}

async function main(): Promise<void> {
    console.log("=== Sample: noteManagerPersistence ===\n");

    const { manager: m1, adapter } = makeManager();

    console.log("Phase 0 — clear persisted state");
    await adapter.clearState();

    console.log("Phase 1 — add notes, flush");
    await m1.loadFromStorage();
    m1.addNote(NOTE_A);
    m1.addNote(NOTE_B);
    await m1.flush();
    console.log(`  notes after flush: ${m1.getNotes().length}`);
    console.log(`  storage: ${STORAGE_DIR}/note-manager.json\n`);

    console.log("Phase 2 — fresh manager, load from disk, verify");
    const { manager: m2 } = makeManager();
    await m2.loadFromStorage();
    const loaded = m2.getNotes();
    console.log(`  notes loaded: ${loaded.length}`);

    if (loaded.length !== 2) {
        throw new Error(`Post-condition violated: expected 2 notes, got ${loaded.length}`);
    }
    const commitments = loaded.map((n) => n.commitment.toLowerCase());
    if (
        !commitments.includes(NOTE_A.commitment.toLowerCase()) ||
        !commitments.includes(NOTE_B.commitment.toLowerCase())
    ) {
        throw new Error(
            "Post-condition violated: loaded commitments do not match persisted commitments.",
        );
    }

    console.log("\n=== noteManagerPersistence complete (assertions passed) ===");
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
