import { parseEther } from "viem";

import { NoteStatus } from "@privacy-pools-v2/evm-sdk";

import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";

const POLL_INTERVAL_MS = 30_000;

/**
 * Blocks until Bob has at least N ACTIVE notes of sufficient value, polling
 * `discoverNotes()`. A deposited note stays PENDING until the ASP includes it
 * in the association set, so spending flows run right after deposits would
 * fail — this is the wait step between the deposit phase and the spend phase
 * of `run-scenario.sh`.
 *
 * Usage: tsx checks/util/waitForActiveNotes.ts [count] [minValueEth] [timeoutMin]
 */
async function main(): Promise<void> {
    const minCount = Number(process.argv[2] ?? "1");
    const minValueEth = process.argv[3] ?? config.depositAmount;
    const timeoutMin = Number(process.argv[4] ?? "30");
    const minValue = parseEther(minValueEth);

    const bob = await createBobPoolSession();
    const deadline = Date.now() + timeoutMin * 60_000;

    for (;;) {
        await bob.poolSession.discoverNotes();
        const account = await bob.poolSession.exportAccount();
        const active = account.notes.filter(
            (n) =>
                n.tokenId.toLowerCase() === config.tokenId.toLowerCase() &&
                n.status === NoteStatus.ACTIVE &&
                BigInt(n.value) >= minValue,
        );
        console.log(
            `${new Date().toISOString()}  ACTIVE notes ≥ ${minValueEth} ETH: ${active.length}/${minCount}`,
        );
        if (active.length >= minCount) {
            console.log(`✓ ${active.length} ASP-approved notes available`);
            process.exit(0);
        }
        if (Date.now() > deadline) {
            throw new Error(
                `Timed out after ${timeoutMin}min waiting for ${minCount} ACTIVE notes ` +
                    `(have ${active.length}). Is the ASP listener approving deposits?`,
            );
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
