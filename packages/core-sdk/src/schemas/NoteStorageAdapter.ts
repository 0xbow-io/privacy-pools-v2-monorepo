import z, { ZodType } from "zod";

import { HexSchema } from "./common.js";
import { makeNoteSchema, NoteSchema } from "./index.js";

export function makeNoteManagerStateSchema<TAddress>(addressSchema: ZodType<TAddress>) {
    return z.object({
        notes: z.array(makeNoteSchema(addressSchema)),
        syncCursor: HexSchema,
    });
}

export const NoteManagerStateSchema = z.object({
    notes: z.array(NoteSchema),
    syncCursor: HexSchema,
});
