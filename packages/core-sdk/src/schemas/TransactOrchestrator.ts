import { z } from "zod";

import { AddressSchema } from "./common.js";

/** Validates the constructor config for TransactOrchestrator, generic over `TAddress`. */
export function makeTransactOrchestratorConfigSchema<TAddress>(
    addressSchema: z.ZodType<TAddress>,
) {
    return z.object({
        ownerAddress: addressSchema,
    });
}

/** Validates the constructor config for TransactOrchestrator. */
export const TransactOrchestratorConfigSchema = makeTransactOrchestratorConfigSchema(AddressSchema);
