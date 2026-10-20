import { Hex } from "./Hex.js";

/**
 * An Ethereum address (20 bytes, 0x-prefixed).
 * Same shape as {@link Hex}; the alias conveys intent.
 */
export type Address = Hex;

/**
 * A Stellar StrKey address — an account ("G...") or contract ("C...") public key, base32-encoded
 * with a version byte and CRC16 checksum (RFC 4648 alphabet). Not `Hex`-shaped; used as the
 * `TAddress` instantiation for Stellar chain adapters/interactors.
 */
export type StellarAddress = string;
