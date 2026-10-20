import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
    bytesToHex,
    hexToBytes,
    managedNonce,
    randomBytes,
    utf8ToBytes,
} from "@noble/ciphers/utils.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";

import type { AtRestScryptParams, Hex, SealedEnvelope } from "../internal.js";
import {
    AT_REST_SALT_BYTES,
    AtRestDecryptionError,
    DEFAULT_AT_REST_SCRYPT_PARAMS,
    ENCRYPTED_STORAGE_VERSION,
    InvalidAtRestPassphrase,
    InvalidEncryptedRecord,
} from "../internal.js";

/**
 * Normalizes a passphrase into an owned byte copy. A `string` is UTF-8 encoded;
 * a `Uint8Array` is cloned so the caller's buffer is never mutated when we
 * later zeroize ours. Rejects an empty passphrase — it would provide no
 * protection at all.
 * @throws {InvalidAtRestPassphrase} When the passphrase is empty.
 */
export function passphraseToBytes(passphrase: string | Uint8Array): Uint8Array {
    const bytes =
        typeof passphrase === "string" ? utf8ToBytes(passphrase) : Uint8Array.from(passphrase);
    if (bytes.length === 0) {
        throw new InvalidAtRestPassphrase();
    }
    return bytes;
}

/**
 * Derives the 32-byte at-rest AEAD key from passphrase bytes and a salt via
 * scrypt (memory-hard, RFC 7914). The returned key is ephemeral and MUST be
 * zeroized by the caller once encryption/decryption is done (mirrors the
 * `key.fill(0)` pattern in {@link CryptoService}).
 */
export async function deriveAtRestKey(
    passphrase: Uint8Array,
    salt: Uint8Array,
    params: AtRestScryptParams,
): Promise<Uint8Array> {
    return scryptAsync(passphrase, salt, {
        N: params.N,
        r: params.r,
        p: params.p,
        dkLen: params.dkLen,
    });
}

/**
 * XChaCha20-Poly1305 encrypt with a managed (random 24-byte) nonce — identical
 * construction to {@link CryptoService.encrypt}. Output is `nonce ‖ ciphertext ‖ tag`,
 * hex-encoded. The key is NOT zeroized here; its lifetime is owned by the caller.
 *
 * `aad` is authenticated but not encrypted: it is covered by the Poly1305 tag, so decryption
 * fails unless the reader supplies byte-identical associated data. It binds a ciphertext to its
 * context (see {@link atRestRecordAad} and {@link AT_REST_ENVELOPE_AAD}); without it, ciphertext
 * is valid under the key alone and can be relocated anywhere the same key applies.
 *
 * It is **required**, not optional, for the same reason `persistNoteUpdates`'s `verification` is:
 * a security parameter that can be omitted is one that will be, silently, and the omission is
 * invisible at the call site because an unbound ciphertext round-trips perfectly.
 */
export function aeadEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Hex {
    const chacha = managedNonce(xchacha20poly1305)(key, aad);
    return ("0x" + bytesToHex(chacha.encrypt(plaintext))) as Hex;
}

/**
 * XChaCha20-Poly1305 decrypt of a hex `nonce ‖ ciphertext ‖ tag` blob. Any
 * failure (wrong key, tampered bytes, truncation, or mismatched `aad`) is surfaced as
 * {@link AtRestDecryptionError} — the plaintext is never returned on failure.
 * @throws {AtRestDecryptionError} When authentication/decryption fails.
 */
export function aeadDecrypt(key: Uint8Array, ciphertext: Hex, aad: Uint8Array): Uint8Array {
    const bytes = hexToBytes(ciphertext.slice(2));
    try {
        const chacha = managedNonce(xchacha20poly1305)(key, aad);
        return chacha.decrypt(bytes);
    } catch (e) {
        throw new AtRestDecryptionError(e instanceof Error ? e.message : String(e));
    }
}

/**
 * Builds the associated data that binds one encrypted store record to its context: the record
 * marker (domain separator), the format version, and the record's LOGICAL STORAGE KEY.
 *
 * Without this binding, a record is authenticated by the key alone. An attacker able to write
 * the backing store could therefore transplant a valid ciphertext from one storage key to
 * another — across owners, chains, or record kinds — and it would decrypt cleanly, because
 * nothing in the sealed bytes says where it belongs. The plaintext storage key and the `m`
 * marker are unauthenticated metadata on their own; folding them in here is what makes them
 * tamper-evident.
 */
export function atRestRecordAad(marker: string, version: number, storageKey: string): Uint8Array {
    return utf8ToBytes(`${marker}|v${version}|${storageKey}`);
}

/**
 * Associated data for the one-shot {@link SealedEnvelope} (`sealValue` / `openSealed`).
 *
 * An envelope is a standalone blob rather than a keyed store entry, so there is no storage key to
 * bind — the binding it needs is domain separation: an envelope must not be openable as a store
 * record, nor a record as an envelope, even under the same passphrase. The version is folded in
 * so a future format change cannot be silently mistaken for the current one.
 */
export const AT_REST_ENVELOPE_AAD: Uint8Array = utf8ToBytes(
    `ppv2-at-rest-envelope|v${ENCRYPTED_STORAGE_VERSION}`,
);

/**
 * One-shot AEAD-seal of an arbitrary JSON-serializable value under a passphrase.
 * Generates a fresh random salt, derives a key via scrypt, encrypts the
 * JSON bytes, and returns a self-describing {@link SealedEnvelope}. The derived
 * key, passphrase copy, and plaintext bytes are all zeroized before returning.
 * @throws {InvalidAtRestPassphrase} When the passphrase is empty.
 */
export async function sealValue<T>(
    value: T,
    passphrase: string | Uint8Array,
    params: AtRestScryptParams = DEFAULT_AT_REST_SCRYPT_PARAMS,
): Promise<SealedEnvelope> {
    const passBytes = passphraseToBytes(passphrase);
    const salt = randomBytes(AT_REST_SALT_BYTES);
    const plaintext = utf8ToBytes(JSON.stringify(value ?? null));
    const key = await deriveAtRestKey(passBytes, salt, params);
    try {
        return {
            v: ENCRYPTED_STORAGE_VERSION,
            kdf: { name: "scrypt", N: params.N, r: params.r, p: params.p, dkLen: params.dkLen },
            salt: ("0x" + bytesToHex(salt)) as Hex,
            ciphertext: aeadEncrypt(key, plaintext, AT_REST_ENVELOPE_AAD),
        };
    } finally {
        key.fill(0);
        passBytes.fill(0);
        plaintext.fill(0);
    }
}

/**
 * Opens a {@link SealedEnvelope} produced by {@link sealValue}, re-deriving the
 * key from the envelope's own salt + KDF parameters and the supplied passphrase.
 * The derived key and passphrase copy are zeroized before returning.
 * @throws {InvalidAtRestPassphrase} When the passphrase is empty.
 * @throws {InvalidEncryptedRecord} When the envelope shape is malformed.
 * @throws {AtRestDecryptionError} When the passphrase is wrong or the envelope was tampered with.
 */
export async function openSealed<T>(
    envelope: SealedEnvelope,
    passphrase: string | Uint8Array,
): Promise<T> {
    assertSealedEnvelope(envelope);
    const passBytes = passphraseToBytes(passphrase);
    const salt = hexToBytes(envelope.salt.slice(2));
    const key = await deriveAtRestKey(passBytes, salt, envelope.kdf);
    try {
        const plaintext = aeadDecrypt(key, envelope.ciphertext, AT_REST_ENVELOPE_AAD);
        try {
            return JSON.parse(new TextDecoder().decode(plaintext)) as T;
        } finally {
            plaintext.fill(0);
        }
    } finally {
        key.fill(0);
        passBytes.fill(0);
    }
}

/**
 * Bounds an untrusted scrypt parameter set before it is fed to the (memory-hard)
 * KDF. Type-validation alone is not enough: a malicious store-writer could plant
 * `N = 2^30`, and the next unlock would attempt a ~1 TiB working set and OOM the
 * process — a denial-of-service on read. Enforces RFC 7914 shape plus the narrow
 * ranges this SDK ever emits: `N` a power of two in `[2^10, 2^20]`, `r` in
 * `[1, 32]`, `p` in `[1, 16]`, and the fixed 32-byte AEAD key length.
 * @throws {InvalidEncryptedRecord} When any parameter is out of its allowed range.
 */
export function assertBoundedScryptParams(kdf: {
    N: number;
    r: number;
    p: number;
    dkLen: number;
}): void {
    const inRange = (v: number, lo: number, hi: number): boolean =>
        Number.isInteger(v) && v >= lo && v <= hi;
    const isPowerOfTwo = (v: number): boolean =>
        Number.isInteger(v) && v > 0 && (v & (v - 1)) === 0;
    if (
        !isPowerOfTwo(kdf.N) ||
        !inRange(kdf.N, 1 << 10, 1 << 20) ||
        !inRange(kdf.r, 1, 32) ||
        !inRange(kdf.p, 1, 16) ||
        kdf.dkLen !== 32
    ) {
        throw new InvalidEncryptedRecord(
            "scrypt KDF parameters are outside the allowed range (possible resource-exhaustion header)",
        );
    }
}

/**
 * Structural guard for an untrusted {@link SealedEnvelope} — runs before any
 * `BigInt`/`hexToBytes` parsing so a malformed field surfaces as
 * {@link InvalidEncryptedRecord} rather than a raw `TypeError`.
 * @throws {InvalidEncryptedRecord} When any required field is missing or the wrong type.
 */
function assertSealedEnvelope(envelope: SealedEnvelope): void {
    const e = envelope as unknown as Record<string, unknown>;
    if (e === null || typeof e !== "object") {
        throw new InvalidEncryptedRecord("sealed envelope is not an object");
    }
    if (typeof e.salt !== "string" || !e.salt.startsWith("0x")) {
        throw new InvalidEncryptedRecord("missing or malformed salt");
    }
    if (typeof e.ciphertext !== "string" || !e.ciphertext.startsWith("0x")) {
        throw new InvalidEncryptedRecord("missing or malformed ciphertext");
    }
    const kdf = e.kdf as Record<string, unknown> | undefined;
    if (
        !kdf ||
        typeof kdf.N !== "number" ||
        typeof kdf.r !== "number" ||
        typeof kdf.p !== "number" ||
        typeof kdf.dkLen !== "number"
    ) {
        throw new InvalidEncryptedRecord("missing or malformed kdf parameters");
    }
    // Bound the values (not just their types) so a hostile envelope cannot OOM the KDF.
    assertBoundedScryptParams({ N: kdf.N, r: kdf.r, p: kdf.p, dkLen: kdf.dkLen });
}
