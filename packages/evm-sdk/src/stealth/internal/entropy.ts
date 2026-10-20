import { StealthAddressDeriveError } from "../errors.js";

/**
 * Bound CSPRNG entry point captured at module load. We bind the
 * `getRandomValues` method to its Crypto receiver here (not just snapshot
 * the Crypto object) so that a later method-level monkey-patch like
 * `globalThis.crypto.getRandomValues = stub` cannot downgrade an already
 * imported handle. v3 audit ENTROPY-07 surfaced the residual risk in the
 * v2 capture-the-object approach.
 *
 * STLTH-13 forbids any deterministic / weak-entropy fallback. WebCrypto only
 * (works in modern browsers, Node 20+, Deno, Bun, Cloudflare Workers). If
 * WebCrypto is absent at module load we capture `null` and refuse every
 * subsequent call per [ENTROPY-04].
 */
const getRandomValuesBound: (<T extends ArrayBufferView>(array: T) => T) | null =
    typeof globalThis !== "undefined" &&
    "crypto" in globalThis &&
    globalThis.crypto != null &&
    typeof globalThis.crypto.getRandomValues === "function"
        ? globalThis.crypto.getRandomValues.bind(globalThis.crypto)
        : null;

/**
 * CSPRNG-only random bytes. Takes no parameters other than `byteLength` so
 * [DEV-13] (no seed argument) holds at the type level.
 */
export const csprngBytes = (byteLength: number): Uint8Array => {
    if (!Number.isInteger(byteLength) || byteLength <= 0 || byteLength > 1024) {
        throw new StealthAddressDeriveError(
            `csprngBytes: byteLength must be a positive integer <= 1024, got ${byteLength}`,
        );
    }
    if (getRandomValuesBound == null) {
        throw new StealthAddressDeriveError(
            "csprngBytes: no CSPRNG available. globalThis.crypto.getRandomValues was missing at module load. " +
                "STLTH-13 forbids deterministic fallback. Stealth derivation refused.",
        );
    }
    const out = new Uint8Array(byteLength);
    getRandomValuesBound(out);
    return out;
};
