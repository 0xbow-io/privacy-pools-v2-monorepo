import { z } from "zod";
import { zNonNegativeBigInt } from "../../relayer.schemas";

// Starknet addresses are field elements - 0x + up to 64 hex chars
export const zStarknetAddress = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);

export type StarknetAddress = z.infer<typeof zStarknetAddress>;

export const zStarknetQuoteRequest = z.object({
    amount: zNonNegativeBigInt,
    recipient: zStarknetAddress.optional(),
    asset: zStarknetAddress,
    extraGas: z.boolean(),
});

export type StarknetQuoteRequest = z.infer<typeof zStarknetQuoteRequest>;
