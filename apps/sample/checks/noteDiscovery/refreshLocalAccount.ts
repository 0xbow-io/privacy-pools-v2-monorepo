import type { Hex } from "@privacy-pools-v2/evm-sdk";
import { NoteStatus } from "@privacy-pools-v2/evm-sdk";

import { refreshLocalAccount } from "../../src/noteDiscovery/refreshLocalAccount.js";
import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";

async function main(): Promise<void> {
    const bob = await createBobPoolSession();
    const account = await refreshLocalAccount(bob.poolSession);

    for (const note of account.notes) {
        if (note.createdAtBlock === "0x0" || !note.createdAtBlock) {
            throw new Error(
                `Note ${note.commitment}: empty createdAtBlock — discoverNotes should have set it.`,
            );
        }
        const nullifierHash = bob.hashService.hash([
            config.bob.privateNullifyingKey,
            note.commitment,
        ]) as Hex;
        const ts = await bob.poolVaultInteractor.getNullifierTimestamp(nullifierHash);
        const onChainSpent = BigInt(ts) !== 0n;
        const localSpent = note.status === NoteStatus.SPENT;
        if (localSpent && !onChainSpent) {
            throw new Error(
                `Note ${note.commitment}: locally SPENT but no on-chain nullifier — impossible state.`,
            );
        }
        if (onChainSpent && !localSpent) {
            throw new Error(
                `Note ${note.commitment}: on-chain nullifier present but local status=${note.status}. ` +
                    "→ discoverNotes() should have flipped this to SPENT during the same scan.",
            );
        }
    }
    console.log(`✓ refreshLocalAccount ok — ${account.notes.length} note(s) consistent`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
