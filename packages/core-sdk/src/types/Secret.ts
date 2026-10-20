import { Hex } from "./Hex.js";

/**
 * Hex-shaped value that must be treated as sensitive (e.g. keys, shared secrets).
 * Same as {@link Hex} at runtime; the type exists to flag usage and reduce accidental exposure.
 */
export type Secret = Hex;
