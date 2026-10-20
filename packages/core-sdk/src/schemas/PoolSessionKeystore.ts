import { z } from "zod";

import { AddressSchema } from "./common.js";

/** Validates the constructor config for {@link PoolSessionKeystore}, generic over `TAddress`. */
export function makePoolSessionKeystoreConfigSchema<TAddress>(addressSchema: z.ZodType<TAddress>) {
    return z.object({
        ownerAddress: addressSchema,
        chainId: z.number().int().positive(),
    });
}

/** Validates the constructor config for {@link PoolSessionKeystore}. */
export const PoolSessionKeystoreConfigSchema = makePoolSessionKeystoreConfigSchema(AddressSchema);
