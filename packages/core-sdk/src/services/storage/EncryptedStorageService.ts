import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";

import type {
    AtRestKdfDescriptor,
    AtRestScryptParams,
    EncryptedStorageServiceConfig,
    Hex,
    IStorageService,
} from "../../internal.js";
import {
    aeadDecrypt,
    aeadEncrypt,
    assertBoundedScryptParams,
    AT_REST_SALT_BYTES,
    atRestRecordAad,
    DEFAULT_AT_REST_SCRYPT_PARAMS,
    deriveAtRestKey,
    ENCRYPTED_STORAGE_HEADER_KEY,
    ENCRYPTED_STORAGE_HEADER_MARKER,
    ENCRYPTED_STORAGE_RECORD_MARKER,
    ENCRYPTED_STORAGE_VERSION,
    EncryptedStorageBaseError,
    InvalidEncryptedRecord,
    passphraseToBytes,
} from "../../internal.js";

/** Per-store KDF header persisted under {@link ENCRYPTED_STORAGE_HEADER_KEY}. */
interface StoredHeader {
    /** Discriminant — {@link ENCRYPTED_STORAGE_HEADER_MARKER}. */
    m: string;
    /** Envelope format version. */
    v: number;
    /** Self-describing scrypt parameters. */
    kdf: AtRestKdfDescriptor;
    /** Random per-store salt, hex-encoded. */
    salt: Hex;
}

/** Per-value ciphertext record persisted under the caller's (plaintext) key. */
interface StoredRecord {
    /** Discriminant — {@link ENCRYPTED_STORAGE_RECORD_MARKER}. */
    m: string;
    /** XChaCha20-Poly1305 sealed value (managed nonce ‖ ciphertext ‖ tag), hex-encoded. */
    ct: Hex;
}

/**
 * AEAD-sealing decorator over any inner {@link IStorageService} (opt-in, additive).
 *
 * Wraps a plaintext backend (`FileStorageService`, `LocalStorageService`, …) so
 * that every stored **value** is XChaCha20-Poly1305-encrypted at rest under a
 * key derived from a runtime passphrase via scrypt (RFC 7914). Addresses
 * RC-03 (#281/#360): note secrets and the shielded-note graph no longer persist
 * in cleartext when this decorator is used.
 *
 * Design:
 * - **Keys pass through unchanged** — only values are encrypted. Higher-level
 *   adapters already build `<version>:<domain>:<chainId>` keys and the
 *   `IStorageService` contract forbids re-prefixing, so key structure (which is
 *   non-secret) stays plaintext; all note/payment secrets live in the values.
 * - **Key management** — a random per-store salt + scrypt parameters are
 *   persisted as a header under a reserved inner-store key. The passphrase is
 *   never persisted; the raw derived key is never persisted. The passphrase
 *   copy and derived key are held only in memory and zeroized by {@link dispose}.
 * - **Wrong passphrase / tampering** — surface via the Poly1305 auth tag as an
 *   {@link EncryptedStorageBaseError}; plaintext is never returned on failure.
 *
 * @remarks A `string` passphrase cannot be wiped (JS strings are immutable);
 * pass a `Uint8Array` for full zeroization. The derived key necessarily lives
 * in memory for the service's lifetime so repeated get/set need not re-run the
 * (memory-hard) KDF; call {@link dispose} when done to zeroize it.
 */
export class EncryptedStorageService implements IStorageService {
    readonly #inner: IStorageService;
    readonly #kdfParams: AtRestScryptParams;
    // ECMAScript #private so the passphrase / derived key are never enumerable
    // (JSON.stringify, Object.keys, spread, crash-reporter dumps all skip them).
    #passphraseBytes: Uint8Array | undefined;
    #derivedKey: Uint8Array | undefined;
    #keyPromise: Promise<Uint8Array> | undefined;
    #disposed = false;

    /**
     * @param config - Service configuration.
     * @param config.inner - Backend store whose values are sealed at rest.
     * @param config.passphrase - Runtime passphrase the key is derived from (never persisted).
     * @param config.kdfParams - Optional scrypt parameter override.
     * @throws {InvalidAtRestPassphrase} When the passphrase is empty.
     */
    constructor(config: EncryptedStorageServiceConfig) {
        this.#inner = config.inner;
        this.#kdfParams = config.kdfParams ?? DEFAULT_AT_REST_SCRYPT_PARAMS;
        // Eagerly validate + take an owned, zeroizable copy of the passphrase.
        this.#passphraseBytes = passphraseToBytes(config.passphrase);
    }

    /**
     * @inheritdoc IStorageService.get
     * @throws {InvalidEncryptedRecord} When the stored value is not a valid encrypted record.
     * @throws {AtRestDecryptionError} When the passphrase is wrong or the ciphertext was tampered with.
     */
    async get<T>(key: string): Promise<T | null> {
        const record = await this.#inner.get<StoredRecord>(key);
        // Empty slot: no decryption needed, so a fresh store never derives a key.
        if (record === null || record === undefined) {
            return null;
        }
        this.#assertRecord(record, key);
        const key32 = await this.#ensureKey();
        // AAD binds the ciphertext to THIS storage key, so a record transplanted from another
        // key (another owner, chain, or record kind) fails authentication instead of decrypting.
        const plaintext = aeadDecrypt(key32, record.ct, this.#recordAad(key));
        try {
            return JSON.parse(new TextDecoder().decode(plaintext)) as T;
        } finally {
            plaintext.fill(0);
        }
    }

    /**
     * @inheritdoc IStorageService.set
     * @throws {InvalidEncryptedRecord} When the persisted KDF header is malformed.
     */
    async set<T>(key: string, value: T): Promise<void> {
        const key32 = await this.#ensureKey();
        const plaintext = utf8ToBytes(JSON.stringify(value ?? null));
        try {
            const record: StoredRecord = {
                m: ENCRYPTED_STORAGE_RECORD_MARKER,
                ct: aeadEncrypt(key32, plaintext, this.#recordAad(key)),
            };
            await this.#inner.set(key, record);
        } finally {
            plaintext.fill(0);
        }
    }

    /** @inheritdoc IStorageService.delete */
    async delete(key: string): Promise<void> {
        await this.#inner.delete(key);
    }

    /**
     * @inheritdoc IStorageService.clear
     *
     * Passes through to the inner store, wiping every entry (including the KDF
     * header). The cached key is discarded so the next write re-establishes a
     * fresh header + salt — keeping the store internally consistent for any
     * later reader.
     */
    async clear(): Promise<void> {
        await this.#inner.clear();
        this.#derivedKey?.fill(0);
        this.#derivedKey = undefined;
        this.#keyPromise = undefined;
    }

    /**
     * Zeroizes the in-memory passphrase copy and derived key. After disposal the
     * service can no longer read or write. Idempotent.
     */
    dispose(): void {
        this.#disposed = true;
        this.#passphraseBytes?.fill(0);
        this.#passphraseBytes = undefined;
        this.#derivedKey?.fill(0);
        this.#derivedKey = undefined;
        this.#keyPromise = undefined;
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /**
     * Returns the cached AEAD key, deriving it once (via the persisted-or-created
     * header) on first use. Concurrent callers share a single in-flight
     * derivation so the memory-hard KDF runs exactly once and only one header is
     * written.
     * @throws {EncryptedStorageBaseError} When the service has been disposed.
     * @throws {InvalidEncryptedRecord} When the persisted header is malformed.
     */
    async #ensureKey(): Promise<Uint8Array> {
        if (this.#disposed || this.#passphraseBytes === undefined) {
            throw new EncryptedStorageBaseError("EncryptedStorageService has been disposed");
        }
        if (this.#derivedKey !== undefined) {
            return this.#derivedKey;
        }
        this.#keyPromise ??= this.#loadOrCreateKey();
        return this.#keyPromise;
    }

    /**
     * Loads (or lazily creates) the per-store KDF header, then derives and caches
     * the AEAD key from it and the retained passphrase.
     * @throws {InvalidEncryptedRecord} When an existing header is malformed.
     */
    async #loadOrCreateKey(): Promise<Uint8Array> {
        // Capture the passphrase buffer reference up front (it is guaranteed present — #ensureKey
        // guards disposal before invoking this). A concurrent dispose() zeroizes this buffer in
        // place, so the derive below may run over zeroed bytes; that is fine because the disposed
        // re-check afterwards throws the result away.
        const passphrase = this.#passphraseBytes!;
        const header = await this.#loadOrCreateHeader();
        const salt = hexToBytes(header.salt.slice(2));
        const derived = await deriveAtRestKey(passphrase, salt, header.kdf);
        // dispose() may have run while the memory-hard KDF above was in flight. Caching now
        // would re-arm #derivedKey on an already-disposed service, leaking a live key past
        // dispose(). Zeroize the fresh key and refuse rather than cache it.
        if (this.#disposed || this.#passphraseBytes === undefined) {
            derived.fill(0);
            throw new EncryptedStorageBaseError("EncryptedStorageService has been disposed");
        }
        this.#derivedKey = derived;
        return derived;
    }

    /**
     * Reads the persisted KDF header, or writes a fresh one (random salt +
     * configured scrypt params) when none exists.
     * @throws {InvalidEncryptedRecord} When an existing header fails shape validation.
     */
    async #loadOrCreateHeader(): Promise<StoredHeader> {
        const existing = await this.#inner.get<StoredHeader>(ENCRYPTED_STORAGE_HEADER_KEY);
        if (existing !== null && existing !== undefined) {
            this.#assertHeader(existing);
            return existing;
        }
        const salt = randomBytes(AT_REST_SALT_BYTES);
        const header: StoredHeader = {
            m: ENCRYPTED_STORAGE_HEADER_MARKER,
            v: ENCRYPTED_STORAGE_VERSION,
            kdf: {
                name: "scrypt",
                N: this.#kdfParams.N,
                r: this.#kdfParams.r,
                p: this.#kdfParams.p,
                dkLen: this.#kdfParams.dkLen,
            },
            salt: ("0x" + bytesToHex(salt)) as Hex,
        };
        await this.#inner.set(ENCRYPTED_STORAGE_HEADER_KEY, header);
        return header;
    }

    /**
     * Associated data binding a record to its storage key, marker, and format version.
     * Recomputed per call rather than cached: it is a few bytes of UTF-8, and deriving it from
     * the key actually in hand is what makes the binding meaningful.
     *
     * The version folded in here is the compile-time `ENCRYPTED_STORAGE_VERSION`, which is safe
     * ONLY because {@link EncryptedStorageService.#assertHeader} rejects a store whose persisted
     * header carries a different version. Without that check, bumping the constant would change
     * every record's AAD and silently make previously-written records fail authentication —
     * indistinguishable from a wrong passphrase. Keep the two together.
     */
    #recordAad(key: string): Uint8Array {
        return atRestRecordAad(ENCRYPTED_STORAGE_RECORD_MARKER, ENCRYPTED_STORAGE_VERSION, key);
    }

    /**
     * Rejects a value that is not a well-formed encrypted record — e.g. a
     * plaintext value written by a non-encrypted backend before the decorator
     * was introduced.
     * @throws {InvalidEncryptedRecord} When the record shape is wrong.
     */
    #assertRecord(record: StoredRecord, key: string): void {
        if (
            record.m !== ENCRYPTED_STORAGE_RECORD_MARKER ||
            typeof record.ct !== "string" ||
            !record.ct.startsWith("0x")
        ) {
            throw new InvalidEncryptedRecord(`value at key "${key}" is not an encrypted record`);
        }
    }

    /**
     * Validates a persisted KDF header before it is trusted for key derivation.
     * @throws {InvalidEncryptedRecord} When the header shape is wrong.
     */
    #assertHeader(header: StoredHeader): void {
        const kdf = header.kdf as Partial<AtRestKdfDescriptor> | undefined;
        // The record AAD (see #recordAad) folds in the compile-time version constant, so a store
        // written under a different version would fail authentication on every read with an error
        // indistinguishable from a wrong passphrase. Reject the mismatch here instead, with a
        // message that names the real cause — and force any future bump to ship a migration.
        if (header.v !== ENCRYPTED_STORAGE_VERSION) {
            throw new InvalidEncryptedRecord(
                `encrypted store version ${String(header.v)} is not supported by this SDK ` +
                    `(expected ${ENCRYPTED_STORAGE_VERSION}); a migration is required`,
            );
        }
        if (
            header.m !== ENCRYPTED_STORAGE_HEADER_MARKER ||
            typeof header.salt !== "string" ||
            !header.salt.startsWith("0x") ||
            !kdf ||
            typeof kdf.N !== "number" ||
            typeof kdf.r !== "number" ||
            typeof kdf.p !== "number" ||
            typeof kdf.dkLen !== "number"
        ) {
            throw new InvalidEncryptedRecord("persisted KDF header is malformed");
        }
        // Bound the values (not just their types): a hostile store-writer could plant
        // e.g. N = 2^30 so the next unlock OOMs the process (DoS on read).
        assertBoundedScryptParams({ N: kdf.N, r: kdf.r, p: kdf.p, dkLen: kdf.dkLen });
    }
}
