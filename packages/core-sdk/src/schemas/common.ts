import { z } from "zod";

import { bigintToHex, Hex } from "../internal.js";

export const HexSchema = z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, "Must represent a valid hexadecimal integer value with 0x prefix")
    .refine(
        (value) => {
            try {
                // Remove '0x' prefix and check if it's a valid integer
                const hexValue = value.slice(2);
                // Check if it's not empty after removing prefix
                if (hexValue.length === 0) return false;
                // Try to parse as BigInt to handle large integers
                BigInt(value);
                return true;
            } catch {
                return false;
            }
        },
        {
            message: "Must represent a valid hexadecimal bigint value with 0x prefix",
        },
    )
    .transform((value) => value as Hex);

export const NoteAddressHashSchema = HexSchema.refine((val) => val.slice(2).length === 64, {
    message: "Note address hash must be a 32-byte hash (64 hex chars)",
});

export const DepositSecretSchema = HexSchema.refine((val) => val.slice(2).length === 64, {
    message: "Deposit secret must be a 32-byte secret (64 hex chars)",
});

export const AddressSchema = HexSchema.refine((val) => val.slice(2).length === 40, {
    message: "Must be a 20-byte Ethereum address (40 hex chars)",
});

/**
 * A field-converted tokenId (`IAddressFieldConverter.toTokenIdField`) — up to 160 bits / 20
 * bytes, matching the shared circuit's `Num2Bits(160)` range check, but NOT required to be
 * exactly that width: RLP encoding strips leading zero bytes, so a converted value whose high
 * byte is zero legitimately decodes shorter than `AddressSchema`'s exact 40 hex chars.
 */
export const TokenIdFieldSchema = HexSchema.refine((val) => val.slice(2).length <= 40, {
    message: "Must be at most a 20-byte field value (40 hex chars)",
});

// NOTE (core-sdk split): StellarAddressSchema / StellarAddressOrEmptySchema (validating a
// Stellar StrKey address, optionally widened to accept the EMPTY_ADDRESS sentinel) were dropped
// here — they belong in stellar-sdk alongside the rest of the Stellar-specific validation.

export const BigIntSchema = z.bigint().refine((value) => value >= 0, {
    message: "Must be a positive integer",
});

export const BooleanSchema = z.boolean();

/**
 * Accepts a decimal string ("12345"), a non-negative number (12345), or an
 * already 0x-prefixed hex string ("0x3039") and normalizes to a 0x-prefixed,
 * 64-char-padded {@link Hex} via {@link bigintToHex}.
 *
 * Use for ASP HTTP fields that arrive as decimal strings but are typed as
 * `Hex` on the SDK boundary so identity comparisons against locally-stored
 * canonical hex (commitments, nullifiers, labels) match.
 */
export const DecimalRepresentationToHexSchema = z
    .union([z.string(), z.number()])
    .transform((value, ctx) => {
        // BigInt("") silently returns 0n — reject explicitly, otherwise an
        // empty wire field would deserialize as a valid zero-value Hex.
        if (value === "") {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Value must not be an empty string",
            });
            return z.NEVER;
        }
        // A JSON number above 2^53 has already lost precision in the JSON parser, so
        // BigInt(value) would round-trip a wrong value and a 256-bit commitment/nullifier
        // would never match local state. Reject it — these fields must arrive as strings.
        if (typeof value === "number" && !Number.isSafeInteger(value)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Number exceeds safe-integer range; send large values as a string",
            });
            return z.NEVER;
        }
        try {
            const big = BigInt(value);
            if (big < 0n) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "Value must be non-negative",
                });
                return z.NEVER;
            }
            return bigintToHex(big);
        } catch {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Value must be a decimal string, hex string, or non-negative number",
            });
            return z.NEVER;
        }
    });
