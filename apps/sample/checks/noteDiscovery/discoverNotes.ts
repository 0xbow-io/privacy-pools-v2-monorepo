import { discoverNotes } from "../../src/noteDiscovery/discoverNotes.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";

async function main(): Promise<void> {
    const bob = await createBobPoolSession();
    const notes = await discoverNotes(bob.poolSession);

    // Internal consistency: no duplicates; every note has a non-zero
    // createdAtBlock (otherwise its timestamped-leaf cannot be computed).
    const seen = new Set<string>();
    for (const note of notes) {
        if (seen.has(note.commitment.toLowerCase())) {
            throw new Error(`Duplicate commitment ${note.commitment}`);
        }
        seen.add(note.commitment.toLowerCase());
        if (note.createdAtBlock === "0x0" || !note.createdAtBlock) {
            throw new Error(
                `Note ${note.commitment} has empty createdAtBlock — proofs against it would fail.`,
            );
        }
    }

    console.log(`Discovered ${notes.length} note(s) for ${bob.address}:`);
    for (const note of notes) {
        console.log(
            `  ${note.commitment}  status=${note.status}  value=${note.value}  block=${note.createdAtBlock}`,
        );
    }
    console.log(`✓ discoverNotes ok — ${notes.length} note(s) consistent`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
