import { secp256k1 } from "@noble/curves/secp256k1.js";

import type { CompressedPubKey, Hex, MetaAddress, UncompressedPubKey } from "./types.js";
import { StealthAddressDeriveError } from "./errors.js";
import { asCompressedPubKey, asUncompressedPubKey, hexToBytes } from "./internal/codec.js";
import { SCHEME_CANONICAL, SCHEME_FLUIDKEY } from "./types.js";

/**
 * Recipient identifier modes accepted by the SDK.
 * - `raw` — a 65-byte uncompressed spending pubkey → the FluidKey variant (`0xfffe`).
 * - `canonical` — a spending + viewing compressed-key pair (the `st:eth:` meta-address) → the
 *   spec-compliant canonical EIP-5564 scheme (`0x0001`). This is the view/spend-separated option
 *   that standard ERC-5564 scanners discover (M-2: makes canonical reachable through the orchestrator).
 *
 * ERC-6538 registry lookup and `username.fkey.eth` CCIP-Read resolution land in v6+ per STLTH-05.
 */
export type RecipientIdentifier =
    | { readonly kind: "raw"; readonly spendingPubKey: Hex }
    | {
          readonly kind: "canonical";
          readonly spendingPubKey: Hex;
          readonly viewingPubKey: Hex;
      };

/**
 * Resolve a recipient identifier to a `MetaAddress`.
 *
 * Two modes are implemented (M-2):
 *   - `raw` -> FluidKey variant: a single 65-byte uncompressed secp256k1 point
 *     (`0x04 || X || Y`), hex-encoded.
 *   - `canonical` -> CanonicalMetaAddress: two 33-byte compressed points
 *     (spending + viewing) per EIP-5564 scheme 1.
 * In both modes the resolver validates curve membership before returning.
 *
 * STLTH-05 declares the resolver's eventual scope: the above + `*.fkey.eth` ENS
 * resolution + ERC-6538 fallback. Those ENS/ERC-6538 paths remain deferred to a
 * subsequent slice.
 */
export const resolveRecipient = (identifier: RecipientIdentifier): MetaAddress => {
    switch (identifier.kind) {
        case "raw": {
            // asUncompressedPubKey enforces 0x-prefixed, 65-byte width, 0x04
            // prefix, and hex-body. Curve membership is the additional v5 check
            // not covered by the brand validator (CRYPTO-09 lessons).
            const spendingPubKey: UncompressedPubKey = asUncompressedPubKey(
                identifier.spendingPubKey,
            );
            try {
                secp256k1.Point.fromBytes(hexToBytes(spendingPubKey)).assertValidity();
            } catch (e) {
                throw new StealthAddressDeriveError(
                    `resolveRecipient (raw): spending pub key is not a valid secp256k1 point: ${(e as Error).message}`,
                );
            }
            return { scheme: SCHEME_FLUIDKEY, spendingPubKey };
        }
        case "canonical": {
            // Canonical EIP-5564 meta-address: two 33-byte compressed points. asCompressedPubKey
            // enforces 0x-prefix, 33-byte width, and a 0x02/0x03 prefix; curve membership is the
            // additional check (CRYPTO-09) the brand validator does not cover — applied to BOTH keys.
            const spendingPubKey: CompressedPubKey = asCompressedPubKey(identifier.spendingPubKey);
            const viewingPubKey: CompressedPubKey = asCompressedPubKey(identifier.viewingPubKey);
            for (const [label, key] of [
                ["spending", spendingPubKey],
                ["viewing", viewingPubKey],
            ] as const) {
                try {
                    secp256k1.Point.fromBytes(hexToBytes(key)).assertValidity();
                } catch (e) {
                    throw new StealthAddressDeriveError(
                        `resolveRecipient (canonical): ${label} pub key is not a valid secp256k1 point: ${(e as Error).message}`,
                    );
                }
            }
            return { scheme: SCHEME_CANONICAL, spendingPubKey, viewingPubKey };
        }
        default: {
            // Exhaustiveness check at the type level. Adding 'ens' / 'erc6538'
            // later forces a compile error here until the case is implemented.
            const _exhaustive: never = identifier;
            throw new StealthAddressDeriveError(
                `resolveRecipient: unsupported identifier kind "${String((_exhaustive as { kind?: string }).kind)}"`,
            );
        }
    }
};
