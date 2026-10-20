import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";
import { RLP } from "@ethereumjs/rlp";

import type { Hex } from "../internal.js";

/**
 * RLP-encodes a flat list of hex byte-strings (no nested lists) — the on-chain `NotePayload`
 * wire format's only shape. `@ethereumjs/rlp` is a pure codec (no EVM/address/ABI semantics,
 * unlike `viem`'s `toRlp`/`fromRlp` this replaces), kept out of `evm-sdk` deliberately: RLP is a
 * generic serialization scheme, and this payload format has nothing to do with any chain's
 * transaction/contract-call encoding.
 */
export function encodeHexListRlp(items: Hex[]): Hex {
    const encoded = RLP.encode(
        items.map((item) => {
            const stripped = item.slice(2);
            // Byte-align an odd-length hex value (e.g. "0x3e8", a bare-minimum-digits integer
            // encoding) by left-padding a zero nibble — matches viem's toRlp/hexToBytes, which
            // this replaces and must stay wire-compatible with: `@noble/ciphers`'s hexToBytes
            // throws on an odd-length string instead of padding it.
            return hexToBytes(stripped.length % 2 === 0 ? stripped : `0${stripped}`);
        }),
    );
    return `0x${bytesToHex(encoded)}` as Hex;
}

/**
 * Decodes RLP-encoded bytes into a flat list of hex byte-strings. Throws if the top-level
 * structure isn't a list (e.g. a bare byte-string or a nested list).
 */
export function decodeHexListRlp(data: Hex): Hex[] {
    const decoded = RLP.decode(hexToBytes(data.slice(2)));
    if (!Array.isArray(decoded)) {
        throw new Error("expected an RLP list, got a single byte-string");
    }
    return decoded.map((item) => `0x${bytesToHex(item as Uint8Array)}` as Hex);
}
