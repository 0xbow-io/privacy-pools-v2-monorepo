import { Address } from "./Address.js";
import { Hex } from "./Hex.js";
import { Label } from "./Label.js";
import { Note } from "./Note.js";
import { Secret } from "./Secret.js";

/**
 * Complete history of a single deposit through all subsequent transfers, generic over the
 * chain's address type `TAddress`.
 * All notes in a lineage share the same label.
 */
export interface NoteLineage<TAddress = Address> {
    /** Label shared by every note in this lineage. */
    label: Label;
    /** Token identifier for all notes in this lineage. */
    tokenId: TAddress;
    /**
     * The secret bound into `label = Poseidon(precommitment, depositSecret)` at
     * deposit time. Present only when the current wallet originated this
     * lineage via deposit; absent on lineages received via transfer, payment
     * request, or note discovery — only the original depositor ever held this
     * value.
     */
    depositSecret?: Secret;
    /** All notes in this lineage. */
    notes: Note<TAddress>[];
    /** All ACTIVE notes in the lineage. */
    activeNotes: Note<TAddress>[];
    /** Sum of all ACTIVE note values. */
    totalValue: Hex;
}
