import type { Hash, Hex, Note, PoolSession, Secret } from "@privacy-pools-v2/evm-sdk";
import { NoteStatus } from "@privacy-pools-v2/evm-sdk";

/**
 * Import a note received out-of-band (cold-start / blind variant).
 *
 * For notes that have NO on-chain announcement — produced by
 * `depositForColdStart` or `transferBlind`. The recipient learned
 * `noteSecret` via a side channel (encrypted DM, sealed envelope, etc.) and
 * already knows everything else about the note from the public on-chain
 * commitment / label. They reconstruct the `Note` and call
 * `importAccount` so the SDK starts treating it like any other note.
 *
 * Once imported, the note is visible to `exportAccount`, `discoverNotes`,
 * `prepareTransfer`, `prepareWithdraw`, `prepareRageQuit`, etc.
 *
 * @param recipientSession   The recipient's PoolSession.
 * @param info               Everything needed to reconstruct the Note. The
 *                           sender returns most of this from `prepared.pendingNote`;
 *                           `createdAtBlock` comes from
 *                           `poolVaultInteractor.getCommitmentTimestamp(commitment)`
 *                           after the deposit/transfer is mined.
 * @returns                  The reconstructed Note that was imported.
 */
export async function importColdStartNote(
    recipientSession: PoolSession,
    info: {
        commitment: Hash;
        label: Hex;
        value: Hex;
        tokenId: Hex;
        noteAddressHash: Hash;
        noteSecret: Secret;
        ownerAddress: Hex;
        createdAtBlock: Hex;
        txHash: Hash;
    },
): Promise<Note> {
    const note: Note = {
        commitment: info.commitment,
        label: info.label,
        value: info.value,
        tokenId: info.tokenId,
        noteAddressHash: info.noteAddressHash,
        noteSecret: info.noteSecret,
        ownerAddress: info.ownerAddress,
        status: NoteStatus.ACTIVE,
        isOwned: true,
        createdAtBlock: info.createdAtBlock,
        spentAtBlock: null,
        txHash: info.txHash,
    };
    // `importAccount` REPLACES the local NoteManager state with the data
    // passed in. If we passed `{ notes: [note], syncCursor: 0x0 }` directly
    // we'd wipe Alice's existing notes and reset the discovery cursor to
    // genesis, forcing a full rescan on next discoverNotes(). Merge instead.
    const existing = await recipientSession.exportAccount();
    const dedupedNotes = [
        ...existing.notes.filter(
            (n) => n.commitment.toLowerCase() !== note.commitment.toLowerCase(),
        ),
        note,
    ];
    await recipientSession.importAccount({
        notes: dedupedNotes,
        syncCursor: existing.syncCursor,
    });
    return note;
}
