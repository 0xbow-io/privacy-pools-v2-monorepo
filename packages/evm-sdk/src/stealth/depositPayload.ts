import type { CompressedPubKey, Hex, SchemeId, UncompressedPubKey } from "./types.js";
import { StealthAddressDeriveError } from "./errors.js";
import {
    asCompressedPubKey,
    asUncompressedPubKey,
    bytesToHex,
    hexToBytes,
} from "./internal/codec.js";
import { SCHEME_CANONICAL, SCHEME_FLUIDKEY } from "./types.js";

/**
 * Packed payload embedded in a plain deposit's `noteData.data` field to deliver a
 * stealth-owned note's encrypted secret without a distinguishing on-chain event —
 * the "Camouflaged dust-rescue delivery" design (superseding the earlier
 * `RelaySwaps.rescueDust`/`DustRescued` approach, which publicly tagged rescue
 * deposits and shrank their anonymity set). Unlike ERC-5564's fixed 1-byte
 * `metadata` field, `noteData.data` is arbitrary-length, so the full announcement
 * payload can travel here instead of a separate event.
 *
 * Wire layout: `schemeId (2 bytes, big-endian) ‖ ephemeralPubKeyLen (1 byte) ‖
 * ephemeralPubKey ‖ viewTag (1 byte) ‖ encryptedNoteSecret (remainder)`.
 * `ephemeralPubKey` is length-prefixed because its width differs by scheme (33
 * bytes compressed vs. 65 bytes uncompressed); `schemeId` gets 2 bytes because
 * FluidKey's placeholder id (`0xfffe`) does not fit in 1.
 */
export interface StealthDepositPayload {
    readonly schemeId: SchemeId;
    readonly ephemeralPubKey: CompressedPubKey | UncompressedPubKey;
    readonly viewTag: number;
    readonly encryptedNoteSecret: Hex;
}

/**
 * Sender-side (relayer/prover) packing — the counterpart consumed by
 * `scanDepositNoteData` (`scan.ts`) on the recipient side.
 *
 * @throws {StealthAddressDeriveError} If `viewTag` is out of range or `ephemeralPubKey`
 *   is too long to length-prefix in a single byte.
 */
export const encodeStealthDepositPayload = (payload: StealthDepositPayload): Hex => {
    if (!Number.isInteger(payload.viewTag) || payload.viewTag < 0 || payload.viewTag > 0xff) {
        throw new StealthAddressDeriveError(
            `viewTag must be an integer in [0, 256), got ${payload.viewTag}`,
        );
    }
    const ephemeralBytes = hexToBytes(payload.ephemeralPubKey);
    if (ephemeralBytes.length > 0xff) {
        throw new StealthAddressDeriveError(
            `ephemeralPubKey too long to length-prefix: ${ephemeralBytes.length} bytes`,
        );
    }
    const secretBytes = hexToBytes(payload.encryptedNoteSecret);

    const out = new Uint8Array(2 + 1 + ephemeralBytes.length + 1 + secretBytes.length);
    out[0] = (payload.schemeId >> 8) & 0xff;
    out[1] = payload.schemeId & 0xff;
    out[2] = ephemeralBytes.length;
    out.set(ephemeralBytes, 3);
    out[3 + ephemeralBytes.length] = payload.viewTag;
    out.set(secretBytes, 3 + ephemeralBytes.length + 1);
    return bytesToHex(out);
};

/**
 * Recipient-side raw header decode — scheme-agnostic byte unpacking only, no
 * cryptography. Malformed/truncated/unrecognized-scheme input returns `null`
 * rather than throwing: `noteData.data` scanning sweeps every ordinary deposit
 * event (most of which were never a stealth payload at all), so a parse miss is
 * the expected common case, not an error.
 *
 * @internal Dispatched-to from `scanDepositNoteData` in `scan.ts`.
 */
export const decodeStealthDepositPayload = (data: Hex): StealthDepositPayload | null => {
    let bytes: Uint8Array;
    try {
        bytes = hexToBytes(data);
    } catch {
        return null;
    }
    if (bytes.length < 4) return null; // 2 (schemeId) + 1 (ephLen) + 1 (viewTag) minimum

    const schemeId = (bytes[0]! << 8) | bytes[1]!;
    if (schemeId !== SCHEME_CANONICAL && schemeId !== SCHEME_FLUIDKEY) return null;

    const ephemeralLen = bytes[2]!;
    const headerEnd = 3 + ephemeralLen + 1;
    if (bytes.length < headerEnd) return null;

    const viewTag = bytes[3 + ephemeralLen]!;
    const encryptedNoteSecret = bytesToHex(bytes.slice(headerEnd));

    try {
        const ephemeralHex = bytesToHex(bytes.slice(3, 3 + ephemeralLen));
        const ephemeralPubKey =
            schemeId === SCHEME_CANONICAL
                ? asCompressedPubKey(ephemeralHex)
                : asUncompressedPubKey(ephemeralHex);
        return { schemeId, ephemeralPubKey, viewTag, encryptedNoteSecret };
    } catch {
        return null;
    }
};
