import type { Hex, PublicKey } from "../internal.js";

/** Length of an X25519 public key in bytes. */
const EPHEMERAL_PUBKEY_BYTES = 32;
/** Length of an X25519 public key in hex characters. */
const EPHEMERAL_PUBKEY_HEX_CHARS = EPHEMERAL_PUBKEY_BYTES * 2;

/**
 * Decodes the opaque bytes from a Note event's `data` field into
 * an ephemeral public key and encrypted payload.
 *
 * Format: `ephemeralPubKey (32 bytes) || encryptedPayload (remaining bytes)`
 *
 * @param dataHex - The 0x-prefixed hex string from Note.data.
 * @returns Object with ephemeralPubKey and encryptedPayload.
 */
export function decodeNoteData(dataHex: Hex): {
    ephemeralPubKey: PublicKey;
    encryptedPayload: Hex;
} {
    const hex = dataHex.slice(2);
    if (hex.length <= EPHEMERAL_PUBKEY_HEX_CHARS) {
        throw new Error(
            `Note data too short: expected more than ${EPHEMERAL_PUBKEY_BYTES} bytes, got ${hex.length / 2}`,
        );
    }
    const ephemeralPubKey = `0x${hex.slice(0, EPHEMERAL_PUBKEY_HEX_CHARS)}` as PublicKey;
    const encryptedPayload = `0x${hex.slice(EPHEMERAL_PUBKEY_HEX_CHARS)}` as Hex;
    return { ephemeralPubKey, encryptedPayload };
}

/**
 * Encodes an ephemeral public key and encrypted payload into the opaque
 * byte format used by the Note event's `data` field.
 *
 * @param ephemeralPubKey - X25519 public key (32 bytes, 0x-prefixed).
 * @param encryptedPayload - The encrypted ciphertext (0x-prefixed).
 * @returns Concatenated 0x-prefixed hex string.
 */
export function encodeNoteData(ephemeralPubKey: PublicKey, encryptedPayload: Hex): Hex {
    return `0x${ephemeralPubKey.slice(2)}${encryptedPayload.slice(2)}` as Hex;
}
