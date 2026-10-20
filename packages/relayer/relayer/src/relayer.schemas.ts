import { Hex } from "viem";
import { z } from "zod";

// Accepts a non-negative decimal or 0x-hex STRING (parsed to bigint with no
// precision loss) or a *safe* JS integer. A JSON number above
// Number.MAX_SAFE_INTEGER is already rounded by the JSON parser before zod ever
// sees it — coercing that rounded value silently corrupts the amount (2^53 is
// only ~0.009 of an 18-decimal token), so unsafe numbers are rejected outright,
// forcing clients to send large values as strings. The string regex also keeps
// malformed input (e.g. "abc", "1.5") from making `BigInt()` throw an uncaught
// RangeError inside the coercion (500 instead of a 400).
export const zNonNegativeBigInt = z
    .union([
        z.string().regex(/^(?:\d+|0x[0-9a-fA-F]+)$/, "must be a non-negative decimal or 0x-hex integer string"),
        z
            .number()
            .int()
            .nonnegative()
            .refine((n) => Number.isSafeInteger(n), {
                message: "number exceeds Number.MAX_SAFE_INTEGER and would lose precision; send it as a string",
            }),
    ])
    .pipe(z.coerce.bigint().nonnegative());

// Address validation schema
export const zAddress = z.string();

// Private key validation schema
export const zPrivateKey = z.string();

// Hex validation schema
export const zHex = z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .transform((v) => v as Hex);
