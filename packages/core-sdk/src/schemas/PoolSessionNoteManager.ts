import { z, ZodType } from "zod";

import { HexSchema } from "./common.js";
import { makePendingNoteSchema, PendingNoteSchema } from "./NoteManager.js";

/**
 * `isOwned: true` is enforced here, not in the service, so depositFor /
 * recipient outputs surface as a Zod failure at the API boundary rather than
 * silently polluting the sender's NoteManager downstream.
 */
export function makeAddNoteParamsSchema<TAddress>(addressSchema: ZodType<TAddress>) {
    return z.object({
        pendingNote: makePendingNoteSchema(addressSchema).refine((n) => n.isOwned, {
            message: "pendingNote.isOwned must be true (addNotes registers sender-owned notes only)",
        }),
        txHash: HexSchema,
    });
}

export const AddNoteParamsSchema = z.object({
    pendingNote: PendingNoteSchema.refine((n) => n.isOwned, {
        message: "pendingNote.isOwned must be true (addNotes registers sender-owned notes only)",
    }),
    txHash: HexSchema,
});

export const MarkNoteSpentParamsSchema = z.object({
    commitment: HexSchema,
    spentAtBlock: HexSchema,
});

export const MarkNoteExitedParamsSchema = z.object({
    commitment: HexSchema,
    exitedAtBlock: HexSchema,
});
