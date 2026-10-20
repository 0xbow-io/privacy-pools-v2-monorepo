import { Hex } from "./Hex.js";

/**
 * An X25519 public key encoded as `0x`-prefixed hex (32 bytes, no prefix byte).
 *
 * Same as {@link Hex} at runtime; the alias exists so function signatures
 * communicate intent.
 *
 * @see {@link PublicKeySchema} for runtime length validation.
 */
export type PublicKey = Hex;
