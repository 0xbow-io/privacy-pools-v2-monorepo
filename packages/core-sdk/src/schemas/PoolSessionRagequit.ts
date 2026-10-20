import { z } from "zod";

import { AddressSchema, HexSchema } from "./common.js";

/** Validates the constructor config for PoolSessionRagequit, generic over `TAddress`. */
export function makePoolSessionRagequitConfigSchema<TAddress>(addressSchema: z.ZodType<TAddress>) {
    return z.object({
        ownerAddress: addressSchema,
    });
}

/** Validates the constructor config for PoolSessionRagequit. */
export const PoolSessionRagequitConfigSchema = makePoolSessionRagequitConfigSchema(AddressSchema);

/** Validates per-call ragequit parameters. */
export const RageQuitParamsSchema = z.object({
    commitment: HexSchema,
    allowUnconfirmedExit: z.boolean().optional().default(false),
});
