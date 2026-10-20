import type { Address, Hash, Label, Note } from "../../internal.js";
import { EmptyBatchSelection, NoteStatus } from "../../internal.js";

/** One transact's worth of input notes for a full-balance batch withdrawal. */
export interface BatchWithdrawGroup {
    /** The shared deposit lineage of every note in the group. */
    label: Label;
    /** Commitments of the input notes this transact spends (length 1..maxInputs). */
    inputCommitments: Hash[];
    /** Total value withdrawn by this transact (sum of input note values). */
    amountOut: bigint;
}

/**
 * Inputs for partitioning a full-balance withdrawal into per-transact groups, generic over the
 * chain's address type `TAddress`.
 */
export interface SelectNotesForFullWithdrawArgs<TAddress = Address> {
    /** All notes tracked for the asset (filtered to the target token by the caller). */
    notes: Note<TAddress>[];
    /** The asset being withdrawn (used only for error reporting). */
    tokenId: string;
    /** Maximum input notes per transact (circuit limit, 5). */
    maxInputs: number;
}

/**
 * Partitions a user's active notes for an asset into per-transact groups for a full-balance
 * batch withdrawal. Notes are grouped by `label` (deposit lineage) first, then each lineage is
 * chunked into groups of at most `maxInputs`. Keeping every transact single-label means its
 * change note is a single 0-value note and per-label value conservation holds trivially
 * (`inputs(label) = amountOut`), avoiding any cross-label `amountOut` ambiguity.
 *
 * Ordering is deterministic (labels and commitments sorted) so the same balance always yields
 * the same batch.
 *
 * @param args - The notes, target token, and per-transact input cap.
 * @returns The per-transact groups covering the entire active balance.
 * @throws {EmptyBatchSelection} When no active notes exist for the asset.
 */
export function selectNotesForFullWithdraw<TAddress = Address>(
    args: SelectNotesForFullWithdrawArgs<TAddress>,
): BatchWithdrawGroup[] {
    const { notes, tokenId, maxInputs } = args;

    const active = notes.filter(
        (note) => note.status === NoteStatus.ACTIVE && BigInt(note.value) > 0n,
    );
    if (active.length === 0) {
        throw new EmptyBatchSelection(tokenId);
    }

    // Group active notes by label (deposit lineage)
    const byLabel = new Map<Label, Note<TAddress>[]>();
    for (const note of active) {
        const lineage = byLabel.get(note.label) ?? [];
        lineage.push(note);
        byLabel.set(note.label, lineage);
    }

    const groups: BatchWithdrawGroup[] = [];
    for (const label of [...byLabel.keys()].sort()) {
        const lineage = byLabel
            .get(label)!
            .slice()
            .sort((a, b) => (a.commitment < b.commitment ? -1 : 1));
        for (let i = 0; i < lineage.length; i += maxInputs) {
            const chunk = lineage.slice(i, i + maxInputs);
            groups.push({
                label,
                inputCommitments: chunk.map((note) => note.commitment),
                amountOut: chunk.reduce((sum, note) => sum + BigInt(note.value), 0n),
            });
        }
    }

    return groups;
}
