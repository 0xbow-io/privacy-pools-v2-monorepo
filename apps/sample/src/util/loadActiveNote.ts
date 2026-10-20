import type { Hex, Note, PoolSession } from "@privacy-pools-v2/evm-sdk";
import { NoteStatus } from "@privacy-pools-v2/evm-sdk";

export type LoadActiveNoteParams = {
    poolSession: PoolSession;
    tokenId: Hex;
    minValue: Hex;
    /** Label for the error message. Defaults to "owner". */
    ownerLabel?: string;
};

/**
 * Refresh chain state via `discoverNotes()`, then return the first ACTIVE note
 * matching `(tokenId, value >= minValue)`. Throws with a guidance message if
 * none is available — the caller is meant to surface that message to the user.
 *
 * Examples that consume a note (transfer/withdraw/ragequit/fulfill) call this
 * to load a usable input note from chain state, replacing the old
 * `account-export.json` round-trip.
 */
export async function loadActiveNote({
    poolSession,
    tokenId,
    minValue,
    ownerLabel = "owner",
}: LoadActiveNoteParams): Promise<Note> {
    await poolSession.discoverNotes();
    const account = await poolSession.exportAccount();
    const candidate = account.notes.find(
        (n) =>
            n.tokenId.toLowerCase() === tokenId.toLowerCase() &&
            n.status === NoteStatus.ACTIVE &&
            BigInt(n.value) >= BigInt(minValue),
    );
    if (!candidate) {
        throw new Error(
            `${ownerLabel}: no ACTIVE note ≥ ${minValue} for token ${tokenId} found after discoverNotes.\n` +
                `→ Run \`pnpm sample:deposit\` (or \`sample:depositForEVMPublish\`) and wait for ASP approval, ` +
                `then re-run this script.`,
        );
    }
    return candidate;
}
