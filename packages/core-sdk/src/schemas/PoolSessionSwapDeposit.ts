import { z } from "zod";

import { AddressSchema, HexSchema } from "./common.js";
import { makePoolSessionDepositSchemas } from "./PoolSessionDeposit.js";

/** Builds the per-call swap-and-deposit params schema for the chain's address type `TAddress`. */
export function makeSwapAndDepositParamsSchema<TAddress>(addressSchema: z.ZodType<TAddress>) {
    const { depositForRecipientSchema } = makePoolSessionDepositSchemas(addressSchema);
    return z.object({
        fromChainId: z.number().int().positive(),
        inputToken: addressSchema,
        depositToken: addressSchema,
        depositAmount: HexSchema,
        fallbackAddress: addressSchema.optional(),
        recipient: depositForRecipientSchema.optional(),
    });
}

/** Validates per-call swap-and-deposit parameters, EVM-address-shaped. */
export const SwapAndDepositParamsSchema = makeSwapAndDepositParamsSchema(AddressSchema);
