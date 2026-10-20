import { z, ZodType } from "zod";

import { NoteStatus } from "../types/index.js";
import { AddressSchema, HexSchema, NoteAddressHashSchema } from "./common.js";

/**
 * Builds a `BaseNoteSchema` parameterized over the chain's address type — `tokenId` is the one
 * chain-shaped field at this layer. Used by `NoteManager`/`PoolSessionExport`/
 * `PoolSessionNoteManager`, which are genuinely generic over `TAddress`; `WitnessPreparationService`
 * stays on the concrete EVM-defaulted {@link NoteSchema} by design (it casts notes through
 * `Address` at its boundary — see `PoolSessionDeposit`'s class doc for that documented narrowing).
 */
export function makeBaseNoteSchema<TAddress>(addressSchema: ZodType<TAddress>) {
    return z.object({
        noteAddressHash: NoteAddressHashSchema,
        commitment: HexSchema,
        value: HexSchema,
        tokenId: addressSchema,
        label: HexSchema,
        status: z.enum(NoteStatus),
    });
}

export function makePendingNoteSchema<TAddress>(addressSchema: ZodType<TAddress>) {
    return makeBaseNoteSchema(addressSchema).extend({
        ownerAddress: addressSchema,
        noteSecret: HexSchema,
        isOwned: z.boolean(),
        depositSecret: HexSchema.optional(),
    });
}

export function makeNoteSchema<TAddress>(addressSchema: ZodType<TAddress>) {
    return makePendingNoteSchema(addressSchema).extend({
        createdAtBlock: HexSchema,
        spentAtBlock: HexSchema.nullable(),
        txHash: HexSchema,
    });
}

export const BaseNoteSchema = makeBaseNoteSchema(AddressSchema);
export const PendingNoteSchema = makePendingNoteSchema(AddressSchema);
export const NoteSchema = makeNoteSchema(AddressSchema);
