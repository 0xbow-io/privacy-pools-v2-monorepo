import { scValToNative, xdr } from "@stellar/stellar-sdk";

import type { Hex } from "../internal.js";

/**
 * Decodes one base64-encoded ScVal XDR string (a `StellarLog` topic entry, or its `data` field)
 * into its native JS representation — the same `scValToNative` step the reference implementation's
 * `EventService.parseEvent`/`tree-helpers.ts` apply before reading named fields off an event.
 */
export function decodeScVal(base64: string): unknown {
    return scValToNative(xdr.ScVal.fromXDR(base64, "base64"));
}

/** Converts a decoded `Bytes`/`BytesN` value (a `Uint8Array`) into a `0x`-prefixed hex string. */
export function bufferToHex(value: unknown): Hex {
    return `0x${Buffer.from(value as Uint8Array).toString("hex")}` as Hex;
}

/**
 * Parses a `StellarLog.ledgerClosedAt` ISO 8601 string into Unix seconds — the same unit
 * `env.ledger().timestamp()` uses on-chain for the leaf-timestamp binding.
 */
export function ledgerClosedAtToUnixSeconds(ledgerClosedAt: string): bigint {
    return BigInt(Math.floor(Date.parse(ledgerClosedAt) / 1000));
}
