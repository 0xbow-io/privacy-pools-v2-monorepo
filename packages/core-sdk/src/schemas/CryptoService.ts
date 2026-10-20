import { hexToBytes } from "@noble/ciphers/utils.js";

import { GENERATED_TAG_BYTES, NONCE_BYTES } from "../constant/index.js";
import { HexSchema } from "./common.js";

/**
 * A protocol secret: 0x-prefixed 32-byte hex (66 chars including prefix).
 * BN254-range conformance is the responsibility of the producer
 * (`CryptoService.generateSecret` / `reduceToBN254Scalar`); enforcing it here
 * would reject reduced field elements that legitimately equal `p - 1`.
 */
export const SecretSchema = HexSchema.superRefine((val, ctx) => {
    if (val.length !== 66) {
        ctx.addIssue({
            code: "custom",
            message: `Secret must be 32 bytes (66 hex chars including 0x), got ${val.length}`,
        });
    }
});

export const CiphertextSchema = HexSchema.superRefine((val, ctx) => {
    const hex = val.slice(2);
    const bytes = hexToBytes(hex);

    if (bytes.length < NONCE_BYTES + GENERATED_TAG_BYTES) {
        ctx.addIssue({
            code: "custom",
            message: "too short (missing nonce or tag)",
        });
    }
});

/**
 * Validates an X25519 private scalar: a 32-byte 0x-prefixed hex string. Curve25519
 * has no "out of range" check — every 32-byte value is a valid clamped scalar — so
 * only the length is enforced here.
 */
export const ViewingPrivateKeySchema = HexSchema.transform((val) => {
    const hex = val.slice(2);
    return hexToBytes(hex);
}).superRefine((bytes, ctx) => {
    if (bytes.length !== 32) {
        ctx.addIssue({
            code: "custom",
            message: `must be 32 bytes, got ${bytes.length}`,
        });
    }
});

/**
 * Validates an X25519 public key: a 32-byte 0x-prefixed hex string with no
 * prefix byte. We also reject the all-zero key explicitly so the schema fails
 * fast at the boundary, before `getSharedSecret` would silently return an
 * all-zero shared secret (RFC 7748 §6.1). Low-order *non-zero* points are
 * caught by `CryptoService.ecdh` via the all-zero shared-secret post-check.
 */
export const PublicKeySchema = HexSchema.transform((val) => {
    const hex = val.slice(2);
    return hexToBytes(hex);
}).superRefine((bytes, ctx) => {
    if (bytes.length !== 32) {
        ctx.addIssue({
            code: "custom",
            message: `must be 32 bytes, got ${bytes.length}`,
        });
        return;
    }
    if (bytes.every((byte) => byte === 0)) {
        ctx.addIssue({
            code: "custom",
            message: "X25519 public key must not be the all-zero point",
        });
    }
});

/**
 * Validates an X25519 public key for Stellar's viewing-key curve: a 32-byte 0x-prefixed hex
 * string with no prefix byte. Structurally identical to {@link PublicKeySchema} — kept as a
 * separate, Stellar-named export for call-site clarity, not because the validation differs.
 *
 * Stellar's viewing key was originally secp256k1 (33-byte compressed), matching
 * the upstream reference implementation's own note-encryption scheme (INTL-15). That was reverted after a real local-
 * network registration attempt confirmed the keystore contract's `viewing_key` field is
 * `BytesN<32>` — 32 bytes, not 33 — and that field is pure off-chain-use storage (never read or
 * verified on-chain), so there was no cryptographic reason tying it to secp256k1 specifically.
 * INTL-15's stated rationale for secp256k1 ("already wired end-to-end and works") did not
 * actually hold once exercised for real. X25519 fits the on-chain field natively with no
 * parity-canonicalization workaround, so `StellarCryptoService.ecdh`/`generateEphemeralKeyPair`/
 * `keyPairFromBytes` now match EVM's curve exactly for this one purpose (root-secret derivation,
 * nullifying/revocable keys, and address-to-field conversion all remain chain-specific).
 */
export const StellarPublicKeySchema = HexSchema.transform((val) => {
    const hex = val.slice(2);
    return hexToBytes(hex);
}).superRefine((bytes, ctx) => {
    if (bytes.length !== 32) {
        ctx.addIssue({
            code: "custom",
            message: `must be 32 bytes, got ${bytes.length}`,
        });
        return;
    }
    if (bytes.every((byte) => byte === 0)) {
        ctx.addIssue({
            code: "custom",
            message: "X25519 public key must not be the all-zero point",
        });
    }
});
