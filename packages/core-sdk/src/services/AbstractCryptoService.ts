import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
    bytesToHex,
    hexToBytes,
    managedNonce,
    randomBytes,
    utf8ToBytes,
} from "@noble/ciphers/utils.js";
import { expand, extract, hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
    Address,
    AddressSchema,
    APP_DERIVATION_INFO,
    AUTH0_REVOCABLE_PREFIX,
    CiphertextSchema,
    DerivedKeyMaterial,
    DeriveFromSignatureConfig,
    Hex,
    ICryptoService,
    IDENTITY_DOMAIN,
    InvalidAddress,
    InvalidCipherText,
    InvalidPrivateKey,
    InvalidSecret,
    KEY_BYTES,
    KeyPair,
    NULLIFYING_INFO,
    PAYMENT_REQUEST_KEY_INFO,
    PROTOCOL_SALT,
    reduceToBN254Scalar,
    Secret,
    SecretSchema,
    u64beCounter,
    VIEWING_DOMAIN,
    VIEWING_KEY_INFO,
    ViewingPrivateKeySchema,
} from "../internal.js";

/**
 * Chain-agnostic base for {@link ICryptoService} implementations. Holds every piece of the
 * signature-based key derivation and symmetric encryption scheme that does NOT depend on the
 * signing curve or address encoding: the layered HKDF tree (appSecret → masterPRK →
 * identityPRK/viewingPRK → nullifying/revocable keys, all reduced mod BN254), XChaCha20-Poly1305
 * encrypt/decrypt, and BN254 secret generation.
 *
 * Extenders (`CryptoService` for EVM, `StellarCryptoService` for Stellar) supply the curve-specific
 * primitives: raw ECDH, ephemeral keypair generation, turning derived bytes into a keypair on their
 * curve, and extracting the root-secret IKM/salt from a chain-native signature.
 */
export abstract class AbstractCryptoService<TDeriveConfig = DeriveFromSignatureConfig>
    implements ICryptoService<TDeriveConfig>
{
    /**
     * @inheritdoc ICryptoService.ecdh
     */
    abstract ecdh(privateKey: Secret, publicKey: string): Secret;

    /**
     * @inheritdoc ICryptoService.generateEphemeralKeyPair
     */
    abstract generateEphemeralKeyPair(): KeyPair;

    /**
     * @inheritdoc ICryptoService.deriveKeysFromSignature
     */
    abstract deriveKeysFromSignature(config: TDeriveConfig): DerivedKeyMaterial;

    /**
     * @inheritdoc ICryptoService.encrypt
     * @throws {InvalidSecret} When the secret hex is invalid.
     */
    encrypt(data: Uint8Array, secret: Secret, associatedData?: Uint8Array): Hex {
        const key = this.secretToKey(secret);
        // `associatedData` is passed through to the AEAD, which treats `undefined` as
        // "no associated data" — the same state every existing ciphertext was written in.
        const chacha = managedNonce(xchacha20poly1305)(key, associatedData);
        const ciphertext = chacha.encrypt(data);
        return ("0x" + bytesToHex(ciphertext)) as Hex;
    }

    /**
     * @inheritdoc ICryptoService.decrypt
     * @throws {InvalidCipherText} When the hex is invalid or too short.
     * @throws {InvalidSecret} When the secret hex is invalid.
     */
    decrypt(ciphertext: Hex, secret: Secret, associatedData?: Uint8Array): Uint8Array {
        const validation = CiphertextSchema.safeParse(ciphertext);
        if (!validation.success) {
            throw new InvalidCipherText(validation.error.issues[0].message);
        }

        const hex = ciphertext.slice(2);
        const bytes = hexToBytes(hex);
        const key = this.secretToKey(secret);
        const chacha = managedNonce(xchacha20poly1305)(key, associatedData);
        return chacha.decrypt(bytes);
    }

    /** @inheritdoc ICryptoService.generateSecret */
    generateSecret(): Secret {
        // 48 bytes per RFC 9380 §5.1 — statistical distance from uniform ≤ 2^-128 after
        // reduction modulo the BN254 scalar field prime. Ensures the result is a valid
        // field element, as required for noteSecret/depositSecret consumed by Poseidon.
        const bytes = randomBytes(48);
        return reduceToBN254Scalar(bytes);
    }

    /**
     * @inheritdoc ICryptoService.derivePaymentRequestKeyPair
     * @throws {InvalidPrivateKey} When viewing private key format is invalid.
     * @throws {InvalidAddress} When owner address format is invalid.
     */
    derivePaymentRequestKeyPair(
        viewingPrivateKey: Secret,
        ownerAddress: Address,
        paymentId: Hex,
    ): KeyPair {
        const validatedPriv = ViewingPrivateKeySchema.safeParse(viewingPrivateKey);
        if (!validatedPriv.success) {
            throw new InvalidPrivateKey(
                `Invalid Viewing Private Key: ${validatedPriv.error.issues[0].message}`,
            );
        }
        const validatedOwner = AddressSchema.safeParse(ownerAddress);
        if (!validatedOwner.success) {
            throw new InvalidAddress(
                `Invalid Owner Address: ${validatedOwner.error.issues[0].message}`,
            );
        }

        const ikm = hexToBytes(viewingPrivateKey.slice(2));
        const salt = hexToBytes(ownerAddress.slice(2));
        const info = utf8ToBytes(`${PAYMENT_REQUEST_KEY_INFO}${paymentId}`);
        const raw = hkdf(sha256, ikm, salt, info, KEY_BYTES);

        try {
            return this.keyPairFromBytes(raw);
        } finally {
            ikm.fill(0);
            raw.fill(0);
        }
    }

    /**
     * Runs the layered HKDF tree from a 32-byte appSecret to produce the three protocol keys.
     * Private by design — appSecret is ephemeral and MUST NOT cross the public API surface.
     * Chain-specific only in the viewing-key step, delegated to {@link keyPairFromBytes}.
     */
    protected deriveKeys(appSecretBytes: Uint8Array, revocableKeyIndex: bigint): DerivedKeyMaterial {
        // Layer 1: single HKDF-Extract — appSecret as IKM, "PP_V2" as salt (RFC 5869 §2.2)
        const masterPRK = extract(sha256, appSecretBytes, utf8ToBytes(PROTOCOL_SALT));

        // Layer 2: domain PRKs via HKDF-Expand — IDENTITY and VIEWING isolate functional key domains
        const identityPRK = expand(sha256, masterPRK, utf8ToBytes(IDENTITY_DOMAIN), 32);
        const viewingPRK = expand(sha256, masterPRK, utf8ToBytes(VIEWING_DOMAIN), 32);

        // Layer 3a: nullifying key — HKDF-Expand(identityPRK, "NULLIFYING", 48) → mod BN254 p
        const nullifyingBytes = expand(sha256, identityPRK, utf8ToBytes(NULLIFYING_INFO), 48);
        const privateNullifyingKey = reduceToBN254Scalar(nullifyingBytes);

        // Layer 3b: revocable key — HKDF-Expand(identityPRK, "AUTH0:REVOCABLE"‖u64be(n), 48) → mod BN254 p
        const revocableInfo = new Uint8Array([
            ...utf8ToBytes(AUTH0_REVOCABLE_PREFIX),
            ...u64beCounter(revocableKeyIndex),
        ]);
        const revocableBytes = expand(sha256, identityPRK, revocableInfo, 48);
        const privateRevocableKey = reduceToBN254Scalar(revocableBytes);

        // Layer 3c: viewing key — 32 bytes → chain-specific curve scalar + public key
        const viewingBytes = expand(sha256, viewingPRK, utf8ToBytes(VIEWING_KEY_INFO), 32);
        const { privateKey: viewingPrivateKey, publicKey: viewingPublicKey } =
            this.keyPairFromBytes(viewingBytes);

        // Zeroize intermediate key material — PRKs and raw HKDF outputs must not persist in memory
        masterPRK.fill(0);
        identityPRK.fill(0);
        viewingPRK.fill(0);
        nullifyingBytes.fill(0);
        revocableBytes.fill(0);
        viewingBytes.fill(0);

        return { privateNullifyingKey, privateRevocableKey, viewingPrivateKey, viewingPublicKey };
    }

    /**
     * Stage 2 of the signature-based derivation: appSecret = HKDF-SHA256(ikm=rootSecret,
     * salt=appIdentifierSalt, info=APP_DERIVATION_INFO, L=32). Output is ephemeral and
     * MUST be zeroized by the caller.
     */
    protected deriveAppSecret(rootSecret: Uint8Array, appIdentifierSalt: Uint8Array): Uint8Array {
        return hkdf(sha256, rootSecret, appIdentifierSalt, utf8ToBytes(APP_DERIVATION_INFO), 32);
    }

    /**
     * Turns HKDF-derived raw bytes into a keypair on this chain's viewing-key curve. Used both
     * for the layered tree's viewing-key step ({@link deriveKeys}) and for
     * {@link derivePaymentRequestKeyPair}'s output — a payment-request key is just another
     * HKDF-derived scalar on the same curve as the account's viewing key.
     */
    protected abstract keyPairFromBytes(rawBytes: Uint8Array): KeyPair;

    /**
     * Derives a 32-byte key from a secret hex string via SHA-256. Used internally by encrypt/decrypt.
     * @throws {InvalidSecret} When hex length is &lt2; or without 0x as prefix.
     */
    private secretToKey(secret: Secret): Uint8Array {
        const validation = SecretSchema.safeParse(secret);
        if (!validation.success) {
            throw new InvalidSecret(validation.error.issues[0].message);
        }

        const hex = secret.slice(2);
        const bytes = hexToBytes(hex);
        return sha256(bytes).slice(0, KEY_BYTES);
    }
}
