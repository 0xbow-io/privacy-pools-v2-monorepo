import {
    Address,
    DerivedKeyMaterial,
    DeriveFromSignatureConfig,
    Hex,
    KeyPair,
    Secret,
} from "../internal.js";

/**
 * Contract for shared-secret derivation and symmetric encrypt/decrypt used by the SDK, generic
 * over the chain-native signature-derivation config `TDeriveConfig` (defaults to EVM's
 * {@link DeriveFromSignatureConfig}). A Stellar implementation derives its root secret from an
 * ed25519 signature rather than an ECDSA `r`, so `deriveKeysFromSignature`'s input shape is the
 * one piece of this interface that varies by chain; everything else (ECDH, AEAD encrypt/decrypt,
 * BN254 secret generation) is value-level and chain-independent once the curve-specific
 * primitives are supplied by the implementation.
 *
 * `derivePaymentRequestKeyPair`'s `ownerAddress` stays concretely EVM `Address` — the
 * payment-request subsystem ({@link IPaymentRequestService}) is EVM-only by the same
 * not-yet-genericized boundary documented on `PoolSessionTransfer`, so widening this one method
 * ahead of that subsystem would add a type parameter with no real second implementation to serve.
 */
export interface ICryptoService<TDeriveConfig = DeriveFromSignatureConfig> {
    /**
     * Performs Elliptic Curve Diffie-Hellman key exchange using X25519 (Curve25519).
     * Computes a shared secret from a private key and a counterparty's public key.
     *
     * @param privateKey - The caller's private key (32-byte hex, 0x-prefixed)
     * @param publicKey - The counterparty's public key (32-byte hex, 0x-prefixed)
     * @returns The shared secret (32-byte hex, 0x-prefixed)
     *
     * @throws {CryptoServiceBaseError} When key format is invalid or ECDH computation fails.
     */
    ecdh(privateKey: Secret, publicKey: string): Secret;

    /**
     * Encrypts `data` with the given secret. Output format is 0x-prefixed hex (nonce + ciphertext + tag).
     *
     * `associatedData` is authenticated but not encrypted: it is covered by the Poly1305
     * tag, so decryption fails unless the reader supplies byte-identical bytes. It is what
     * binds a ciphertext to a context — a chain, a vault, an event. Without it a ciphertext
     * is valid under the secret alone, so the same bytes replayed into any other deployment
     * where that secret applies decrypt there exactly as they do here.
     *
     * Optional, and omitting it is byte-for-byte identical to the construction that existed
     * before this parameter, so existing ciphertexts stay readable. New callers should pass
     * one; see `NoteComputationService.encryptAndWrap` for why the on-chain note payloads
     * cannot simply start doing so.
     *
     * @param data - The raw data to encrypt.
     * @param secret - The secret to use for encryption.
     * @param associatedData - Optional context the ciphertext is bound to. The reader must
     *   supply the same bytes; omitting it binds the ciphertext to nothing.
     * @returns The encrypted data as 0x-prefixed hex (nonce + ciphertext + tag).
     * @throws {CryptoServiceBaseError} When the secret hex is invalid.
     */
    encrypt(data: Uint8Array, secret: Secret, associatedData?: Uint8Array): Hex;

    /**
     * Decrypts ciphertext produced by {@link encrypt} using the same secret and the same
     * associated data. A mismatch in either fails authentication and throws; no plaintext is
     * returned on failure.
     *
     * @param ciphertext - The 0x-prefixed hex ciphertext to decrypt.
     * @param secret - The secret to use for decryption.
     * @param associatedData - The exact bytes passed to {@link encrypt}, if any.
     * @returns The decrypted data as raw bytes.
     * @throws {CryptoServiceBaseError} When the ciphertext or secret is invalid.
     */
    decrypt(ciphertext: Hex, secret: Secret, associatedData?: Uint8Array): Uint8Array;

    /**
     * Generates a cryptographically secure random secret as a BN254 scalar field element
     * (in `[0, p-1]`). Used for noteSecret, depositSecret, and other protocol secrets that
     * are consumed by Poseidon and circuit signals.
     * @returns A random BN254 field element as 0x-prefixed hex string.
     */
    generateSecret(): Secret;

    /**
     * Generates a new ephemeral X25519 key pair.
     * @returns An object containing the private key and 32-byte public key, both as 0x-prefixed hex strings.
     */
    generateEphemeralKeyPair(): KeyPair;

    /**
     * Derives the protocol's three private keys from a wallet signature and signer address.
     * Two-stage HKDF-SHA256 (per signature-based derivation spec):
     *   1. rootSecret = HKDF(ikm=r, salt=signerAddress, info=ROOT_DERIVATION_INFO, L=32)
     *   2. appSecret  = HKDF(ikm=rootSecret, salt=APP_IDENTIFIER, info=APP_DERIVATION_INFO, L=32)
     * Then runs the layered HKDF tree: appSecret → masterPRK → identityPRK/viewingPRK → keys.
     *
     * SDK-owned intermediates (internal signature bytes, `r`, rootSecret, appSecret, PRKs) are
     * zeroized after use. However, JavaScript strings are immutable and cannot be zeroized —
     * the caller's `config.signature` hex string will persist in memory until GC.
     * Callers handling sensitive signatures SHOULD drop all references immediately after this
     * call returns so the string becomes garbage-collectible.
     *
     * @param config.signature - 65-byte ECDSA signature (EIP-712 recommended) as 0x-prefixed hex.
     * @param config.signerAddress - 20-byte EVM address that produced the signature.
     * @param config.revocableKeyIndex - Rotation index for the revocable key (u64, big-endian). Defaults to 0.
     * @param config.addressHash - EIP-712 `message.addressHash` from the signed payload. Must equal
     *   `keccak256(signerAddress)` (spec Step 4 — integrator-bug / replay defence).
     * @returns The three derived private keys plus the 32-byte X25519 viewing public key.
     * @throws {CryptoServiceBaseError} When signature or address format is invalid, or when
     *   `addressHash` does not match `keccak256(signerAddress)`.
     *
     * The `@param`/`@throws` details above describe the EVM default shape ({@link
     * DeriveFromSignatureConfig}); a non-EVM implementation's `TDeriveConfig` carries whatever
     * chain-native signature/address fields its own root-secret derivation needs instead.
     */
    deriveKeysFromSignature(config: TDeriveConfig): DerivedKeyMaterial;

    /**
     * Deterministically derives an X25519 key pair for a payment request. The
     * private key never needs to be persisted: it is re-derivable from the
     * triple `(viewingPrivateKey, ownerAddress, paymentId)`. Storage adapters
     * therefore keep only `paymentId` and `paymentPubKey`; consumers (note
     * discovery, replay across sessions) rehydrate `paymentPrivKey` on demand.
     *
     * HKDF-SHA256 with `ikm = viewingPrivateKey`, `salt = ownerAddress`,
     * `info = "payment-request-key/" + paymentId`, `L = 32`. Output is clamped
     * per RFC 7748 and the matching X25519 public key is derived.
     *
     * @throws {CryptoServiceBaseError} When key or address format is invalid.
     */
    derivePaymentRequestKeyPair(
        viewingPrivateKey: Secret,
        ownerAddress: Address,
        paymentId: Hex,
    ): KeyPair;
}
