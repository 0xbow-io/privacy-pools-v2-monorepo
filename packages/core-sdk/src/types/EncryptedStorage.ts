import type { Hex, IStorageService } from "../internal.js";

/**
 * scrypt (RFC 7914) work parameters used to derive the at-rest AEAD key from a
 * runtime passphrase.
 */
export interface AtRestScryptParams {
    /** CPU/memory cost — must be a power of two (e.g. `2 ** 17`). */
    N: number;
    /** Block size (8 is standard). */
    r: number;
    /** Parallelization factor (1 is standard). */
    p: number;
    /** Derived-key length in bytes (32 for XChaCha20-Poly1305). */
    dkLen: number;
}

/** Self-describing KDF descriptor persisted alongside every salt so old data stays openable. */
export interface AtRestKdfDescriptor extends AtRestScryptParams {
    /** KDF identifier. Only `"scrypt"` is currently emitted. */
    name: "scrypt";
}

/**
 * A one-shot AEAD-sealed envelope produced by {@link IPoolSessionExport.exportAccountSealed}.
 * Carries everything needed to re-derive the key and decrypt on another device
 * given only the passphrase — the passphrase itself is never included.
 */
export interface SealedEnvelope {
    /** Envelope format version ({@link ENCRYPTED_STORAGE_VERSION}). */
    v: number;
    /** KDF descriptor (salt is a sibling field, not part of this object). */
    kdf: AtRestKdfDescriptor;
    /** Random per-envelope scrypt salt, hex-encoded. */
    salt: Hex;
    /** XChaCha20-Poly1305 ciphertext (managed nonce ‖ ciphertext ‖ tag), hex-encoded. */
    ciphertext: Hex;
}

/**
 * Configuration for {@link EncryptedStorageService} — the AEAD-sealing
 * decorator over any inner {@link IStorageService}.
 */
export interface EncryptedStorageServiceConfig {
    /** The backend store whose values are sealed at rest (e.g. FileStorageService). */
    inner: IStorageService;
    /**
     * Runtime passphrase the storage key is derived from via scrypt. Never
     * persisted. Prefer a `Uint8Array` — the service zeroizes its internal copy
     * after key derivation, but a `string` passphrase cannot be wiped (JS
     * strings are immutable), so the caller retains that copy.
     */
    passphrase: string | Uint8Array;
    /** Optional scrypt parameter override. Defaults to {@link DEFAULT_AT_REST_SCRYPT_PARAMS}. */
    kdfParams?: AtRestScryptParams;
}
