import { z } from "zod";

import { EMPTY_ADDRESS } from "../internal.js";
import { AddressSchema, HexSchema } from "./common.js";

/**
 * Validates per-call withdraw parameters, generic over the chain's address type `TAddress`.
 * `emptyAddress` is the chain's zero/sentinel address value, used as the default for
 * `relayAddress`/`processorAddress` when omitted.
 */
export function makeWithdrawParamsSchema<TAddress extends string>(
    addressSchema: z.ZodType<TAddress>,
    emptyAddress: TAddress,
) {
    return z.object({
        inputCommitments: z.array(HexSchema).min(1),
        amount: HexSchema,
        tokenId: addressSchema,
        recipientAddress: addressSchema,
        relayAddress: addressSchema.optional().default(emptyAddress),
        feeAmount: HexSchema.optional().default("0x0"),
        processorAddress: addressSchema.optional().default(emptyAddress),
        nativeGas: HexSchema.optional().default("0x0"),
        feeRecipient: addressSchema.optional(),
        extraGas: z.boolean().optional().default(false),
    });
}

/** Validates per-call withdraw parameters. */
export const WithdrawParamsSchema = makeWithdrawParamsSchema(AddressSchema, EMPTY_ADDRESS);
