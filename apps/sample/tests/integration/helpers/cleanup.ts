import type { Hash, Hex } from "@privacy-pools-v2/evm-sdk";

import type { TestContext } from "./types.js";
import { ragequit } from "./operations.js";
import { returnFundsToFaucet } from "./fund.js";

/**
 * Cleans up all actors in the test context:
 * 1. Ragequits any unspent notes (to extract funds from the pool)
 * 2. Returns remaining ETH to the faucet
 *
 * Every operation is wrapped in try/catch — cleanup never aborts on first error.
 */
export async function cleanupAllActors(ctx: TestContext): Promise<void> {
    console.log("\n  [cleanup] Starting fund recovery...");

    for (const actor of ctx.actors) {
        // Ragequit all unspent notes
        const accountExport = actor.accountExport ?? safeExportAccount(actor);

        if (accountExport) {
            for (const note of accountExport.notes) {
                const isUnspent =
                    note.status !== "SPENT" && note.status !== "EXITED";
                const isOwned = !("isOwned" in note) || note.isOwned !== false;

                if (isUnspent && isOwned) {
                    try {
                        await ragequit(actor, note.commitment as Hash);
                    } catch (error) {
                        console.warn(
                            `  [cleanup] Failed to ragequit note ${note.commitment} ` +
                            `for ${actor.name}: ${error}`,
                        );
                    }
                }
            }
        }

        // Return remaining ETH to faucet
        try {
            await returnFundsToFaucet(actor, ctx);
        } catch (error) {
            console.warn(
                `  [cleanup] Failed to return funds for ${actor.name}: ${error}`,
            );
        }
    }

    console.log("  [cleanup] Fund recovery complete.\n");
}

/**
 * Safely exports the actor's account. Returns undefined if the session
 * is not initialized or export fails.
 */
function safeExportAccount(actor: { name: string; poolSession?: unknown }) {
    try {
        const session = actor.poolSession as
            | { exportAccount: () => unknown }
            | undefined;
        if (session?.exportAccount) {
            return session.exportAccount() as {
                notes: { commitment: string; status: string }[];
            };
        }
    } catch {
        console.warn(`  [cleanup] Could not export account for ${actor.name}`);
    }
    return undefined;
}
