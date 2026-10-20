import type { DiscoverNotesParams, Note, PoolSession } from "@privacy-pools-v2/evm-sdk";

/**
 * Note discovery scan.
 *
 * Scans transfer events since the NoteManager's sync cursor, runs ECDH +
 * decrypt against each, persists matching notes, and returns the full local
 * note list (existing + newly discovered).
 *
 * Pass `params.contacts` (each `{ name, viewingPublicKey }`) to switch to
 * targeted discovery — only notes encrypted to a known contact are scanned.
 * Faster but skips anonymous senders. Pass `params.fromBlock` to override
 * the NoteManager's sync cursor and rescan an earlier window.
 *
 * @param session   PoolSession.
 * @param params    Optional `{ contacts?, fromBlock? }`. Omit for catch-all.
 * @returns         All notes the SDK currently knows about for this session.
 */
export async function discoverNotes(
    session: PoolSession,
    params?: DiscoverNotesParams,
): Promise<Note[]> {
    return session.discoverNotes(params);
}
