import type { Hex } from "../internal.js";

/**
 * The anonymous tag value: bytes32(0).
 * Outputs with this tag are from anonymous senders and must be
 * discovered via catch-all ECDH trial decryption.
 */
export const CATCH_ALL_TAG: Hex = `0x${"00".repeat(32)}` as Hex;
