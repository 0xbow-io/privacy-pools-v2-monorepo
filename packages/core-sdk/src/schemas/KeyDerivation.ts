import { HexSchema } from "./common.js";

/** Validates a 65-byte (130 hex chars) ECDSA signature as a 0x-prefixed hex string. */
export const SignatureSchema = HexSchema.superRefine((val, ctx) => {
    const hexChars = val.slice(2);
    if (hexChars.length !== 130) {
        ctx.addIssue({
            code: "custom",
            message: `must be 65 bytes (130 hex chars), got ${hexChars.length / 2} bytes`,
        });
    }
});

/** Validates a 64-byte (128 hex chars) raw ed25519 signature as a 0x-prefixed hex string. */
export const StellarSignatureSchema = HexSchema.superRefine((val, ctx) => {
    const hexChars = val.slice(2);
    if (hexChars.length !== 128) {
        ctx.addIssue({
            code: "custom",
            message: `must be 64 bytes (128 hex chars), got ${hexChars.length / 2} bytes`,
        });
    }
});
