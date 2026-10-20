import type { AccountExport, PoolSession } from "@privacy-pools-v2/evm-sdk";

/**
 * Refresh the local account from chain.
 *
 * Calls `discoverNotes()` (which advances the sync cursor, fetches new
 * commitments, and updates `SPENT` status for any nullifier that has been
 * published) and returns the post-sync `AccountExport`.
 *
 * Use this after long absences from the chain, after spending notes via
 * a different client, or as a periodic background sync.
 *
 * @param session   PoolSession.
 * @returns         AccountExport: `{ notes, syncCursor }`.
 */
export async function refreshLocalAccount(session: PoolSession): Promise<AccountExport> {
    await session.discoverNotes();
    return session.exportAccount();
}
