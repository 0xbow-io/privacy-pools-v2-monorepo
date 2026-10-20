import type { AtRestScryptParams } from "../types/EncryptedStorage.js";
import { KEY_BYTES } from "./CryptoService.js";

/**
 * Envelope format version for the AEAD-sealed at-rest storage layer. Persisted
 * inside every header and sealed export so a future format change can be
 * detected and migrated rather than silently mis-decrypted.
 */
export const ENCRYPTED_STORAGE_VERSION = 1;

/**
 * Reserved inner-store key under which {@link EncryptedStorageService} persists
 * its per-store KDF header (salt + scrypt parameters). Chosen to be disjoint
 * from the `<version>:<domain>:<chainId>` key space used by higher-level
 * adapters (`NoteStorageAdapter`, `PaymentRequestStorageAdapter`) so it cannot
 * collide with a real note/payment-request key.
 */
export const ENCRYPTED_STORAGE_HEADER_KEY = "__ppv2_encrypted_storage__:v1:header";

/** Discriminant stamped into each persisted KDF header so a malformed / foreign value is rejected. */
export const ENCRYPTED_STORAGE_HEADER_MARKER = "ppv2-enc-header";

/** Discriminant stamped into each persisted ciphertext record so a plaintext / foreign value is rejected. */
export const ENCRYPTED_STORAGE_RECORD_MARKER = "ppv2-enc";

/**
 * Default scrypt (RFC 7914) work parameters for deriving the at-rest AEAD key
 * from a runtime passphrase. `N = 2^17`, `r = 8`, `p = 1` ⇒ ~128 MiB memory —
 * an interactive-grade, memory-hard cost that makes offline brute force of a
 * low-entropy passphrase expensive. Persisted alongside the salt so a store
 * sealed under one parameter set stays openable even if the default changes.
 * Tests may inject cheaper parameters via `EncryptedStorageServiceConfig.kdfParams`.
 */
export const DEFAULT_AT_REST_SCRYPT_PARAMS: AtRestScryptParams = {
    N: 1 << 17,
    r: 8,
    p: 1,
    dkLen: KEY_BYTES,
};

/** Byte length of the random per-store / per-envelope scrypt salt. */
export const AT_REST_SALT_BYTES = 16;
