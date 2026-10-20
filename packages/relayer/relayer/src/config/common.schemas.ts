import { z } from "zod";
import { BPS } from "../quote/evm/unit.types";

// Fee BPS validation schema
export const zFeeBps = z
    .string()
    .or(z.number())
    .pipe(z.coerce.bigint().nonnegative().max(10_000n))
    .transform((v) => BPS(v));

// Withdraw amount validation schema
export const zWithdrawAmount = z.string().or(z.number()).pipe(z.coerce.bigint().nonnegative());

export const zQuoteExpirationTimeMs = z.coerce
    .number()
    .positive()
    .min(10_000, "Quote expiration must be at least 10000ms")
    .default(60_000);

