import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

// `extends` needs the base class value synchronously at module-evaluation time. Going through
// this package's own `../internal.js` barrel creates a circular import here (internal.ts ->
// services/index.ts -> this file -> internal.ts) that leaves `AbstractCryptoService` undefined
// at class-evaluation time, exactly like the same-directory case this comment originally
// described in packages/sdk — only now the cycle runs through the local barrel instead of a
// same-directory sibling (AbstractCryptoService itself lives in core-sdk now, not stellar-sdk).
// Importing directly from the dependency's own package entry (no cycle: core-sdk never imports
// stellar-sdk) is the fix, mirroring evm-sdk's identical `CryptoService.ts` precedent.
import { AbstractCryptoService } from "@privacy-pools-v2/core-sdk";
import {
    BN254_SCALAR_MODULUS,
    bytesToBigIntBE,
    clampToCurve25519,
    DerivedKeyMaterial,
    ECDHComputationError,
    Hex,
    InvalidPrivateKey,
    InvalidPublicKey,
    InvalidSignature,
    KeyPair,
    Secret,
    STELLAR_ROOT_INFO,
    STELLAR_ROOT_SALT,
    stellarErrorMessage,
    StellarDeriveFromSignatureConfig,
    StellarPublicKeySchema,
    StellarSignatureSchema,
    ViewingPrivateKeySchema,
} from "../internal.js";

/** `2^160 - 1` — masks a 256-bit value down to its low 160 bits, for {@link stellarTokenIdToField}. */
const TOKEN_ID_MASK = (1n << 160n) - 1n;

/**
 * Stellar implementation of {@link ICryptoService} (via {@link AbstractCryptoService}). Uses
 * X25519 for ECDH and the viewing-key curve — same curve as EVM — and derives its rootSecret
 * from a raw ed25519 wallet signature rather than an EIP-712 ECDSA one.
 *
 * The viewing-key curve was originally secp256k1 (33-byte compressed), matching
 * the upstream reference implementation's own note-encryption scheme (INTL-15). Reverted to X25519 after a real
 * local-network keystore registration confirmed the on-chain `viewing_key` field is `BytesN<32>`
 * — 32 bytes, not 33 — and is pure off-chain-use storage with no on-chain cryptographic
 * verification, so nothing tied it to secp256k1 specifically. INTL-15's stated rationale for
 * secp256k1 ("already wired end-to-end and works") did not hold once actually exercised. See
 * {@link StellarPublicKeySchema}'s doc comment for the full account.
 *
 * Only the rootSecret stage (`deriveRootSecret`) is chain-specific. Everything after it —
 * appSecret (`deriveAppSecret`) and the layered HKDF tree (`deriveKeys`) — is the exact same
 * inherited code EVM uses, including EVM's `APP_DERIVATION_INFO` info string: the two chains'
 * rootSecret values are already cryptographically unrelated by that point (different signature
 * scheme, different salt/info, different IKM), so sharing the appSecret-stage info string
 * introduces no cross-chain key-collision risk. The cost is that this class's derived keys are
 * NOT byte-identical to the upstream reference implementation past the rootSecret stage
 * (that implementation uses its own `"APP"` info string there instead) — a deliberate choice to
 * reuse the shared derivation code rather than duplicate it, not an oversight.
 */
export class StellarCryptoService extends AbstractCryptoService<StellarDeriveFromSignatureConfig> {
    /**
     * @inheritdoc ICryptoService.ecdh
     * @throws {InvalidPrivateKey} When private key format is invalid.
     * @throws {InvalidPublicKey} When public key format is invalid or point not on curve.
     * @throws {ECDHComputationError} When ECDH computation fails or yields an
     *   all-zero shared secret (contributory check per RFC 7748 §6.1).
     */
    ecdh(privateKey: Secret, publicKey: string): Secret {
        const validatedPrivKey = ViewingPrivateKeySchema.safeParse(privateKey);
        if (!validatedPrivKey.success) {
            throw new InvalidPrivateKey(
                `Invalid Private Key: ${validatedPrivKey.error.issues[0].message}`,
            );
        }

        const validatedPubKey = StellarPublicKeySchema.safeParse(publicKey);
        if (!validatedPubKey.success) {
            throw new InvalidPublicKey(
                `Invalid Public Key: ${validatedPubKey.error.issues[0].message}`,
            );
        }

        let sharedSecret: Uint8Array;
        try {
            sharedSecret = x25519.getSharedSecret(validatedPrivKey.data, validatedPubKey.data);
        } catch (error) {
            throw new ECDHComputationError(stellarErrorMessage(error));
        }

        // RFC 7748 §6.1: an all-zero output indicates a low-order / non-contributory public
        // key. Continuing would yield a constant, publicly-known SHA-256(zeros) encryption key.
        if (sharedSecret.every((byte) => byte === 0)) {
            throw new ECDHComputationError(
                "ECDH produced all-zero shared secret — public key is low-order or non-contributory",
            );
        }

        return ("0x" + bytesToHex(sharedSecret)) as Secret;
    }

    /** @inheritdoc ICryptoService.generateEphemeralKeyPair */
    generateEphemeralKeyPair(): KeyPair {
        const { publicKey, secretKey } = x25519.keygen();
        const privateKeyHex = ("0x" + bytesToHex(secretKey)) as Secret;

        secretKey.fill(0);
        const publicKeyHex = ("0x" + bytesToHex(publicKey)) as Hex;
        return { privateKey: privateKeyHex, publicKey: publicKeyHex };
    }

    /**
     * @inheritdoc ICryptoService.deriveKeysFromSignature
     * @throws {InvalidSignature} When the signature is not 64 bytes.
     */
    deriveKeysFromSignature(config: StellarDeriveFromSignatureConfig): DerivedKeyMaterial {
        const rootSecret = this.deriveRootSecret(config);
        const appSecretBytes = this.deriveAppSecret(rootSecret, utf8ToBytes(config.appIdentifier));

        try {
            return this.deriveKeys(appSecretBytes, BigInt(config.revocableKeyIndex));
        } finally {
            // rootSecret and appSecret MUST NOT persist beyond this call.
            rootSecret.fill(0);
            appSecretBytes.fill(0);
        }
    }

    /**
     * Converts a Stellar StrKey account address (e.g. `"G..."`) into a BN254 scalar-field
     * element, matching the on-chain `address_to_field` computation:
     * `keccak256(address_strkey_ascii_bytes) % SNARK_SCALAR_FIELD`. Hashes the StrKey's raw
     * ASCII text directly — it is NOT base32-decoded first, matching
     * the reference implementation's `addressToField` exactly.
     *
     * EVM has no equivalent: an EVM address already fits as a field element (160 bits), so
     * `EvmAddressFieldConverter.toField` is an identity function. A Stellar StrKey does not, so
     * this conversion needs to be an explicit, nameable function whose output the on-chain
     * Soroban contract independently reproduces — not an implicit side effect of a shared
     * hashing abstraction.
     *
     * @param stellarAddress - The Stellar StrKey account address.
     * @returns The field element as 0x-prefixed hex.
     */
    stellarAddressToField(stellarAddress: string): Hex {
        const hash = keccak_256(utf8ToBytes(stellarAddress));
        const field = bytesToBigIntBE(hash) % BN254_SCALAR_MODULUS;
        return ("0x" + field.toString(16).padStart(64, "0")) as Hex;
    }

    /**
     * Converts a Stellar token/asset StrKey address into the 160-bit-bounded field element the
     * shared Deposit/Transact circuits' `tokenId`/`tokenIdOut` signals require, matching the
     * on-chain `encode_token_id` computation: `keccak256(strkey_ascii_bytes) & (2^160 - 1)` (the
     * low 160 bits, NOT a modulo reduction). Distinct from {@link stellarAddressToField}: the
     * circuit range-checks `tokenId < 2^160` (mirroring an EVM address's bit width) but does not
     * constrain owner/recipient addresses, so token IDs need this narrower conversion — verified
     * directly against `contracts/soroban-v2-utils/src/lib.rs`'s `encode_token_id`, not guessed;
     * `stellarAddressToField`'s full-~254-bit output fails this range check for virtually any
     * input, which a real local-network deposit surfaced before this method existed.
     *
     * @param tokenAddress - The Stellar StrKey token/asset address.
     * @returns The field element as 0x-prefixed hex, guaranteed `< 2^160`.
     */
    stellarTokenIdToField(tokenAddress: string): Hex {
        const hash = keccak_256(utf8ToBytes(tokenAddress));
        const field = bytesToBigIntBE(hash) & TOKEN_ID_MASK;
        // Deliberately not zero-padded — see StellarAddressFieldConverter.toTokenIdField's doc
        // comment (kept in sync with this formula) for why a fixed-width pad breaks the
        // RLP-encoded note-payload round-trip.
        return ("0x" + field.toString(16)) as Hex;
    }

    /**
     * Stage 1 of the signature-based derivation: rootSecret = HKDF-SHA256(ikm=signature,
     * salt=STELLAR_ROOT_SALT, info=STELLAR_ROOT_INFO, L=32). Unlike EVM's `deriveRootSecret`,
     * the full raw signature is used as IKM directly — no r-value extraction — and there is no
     * signer-binding check; see {@link StellarDeriveFromSignatureConfig}'s doc for why. Output
     * is ephemeral and MUST be zeroized by the caller.
     */
    protected deriveRootSecret(config: StellarDeriveFromSignatureConfig): Uint8Array {
        const sigValidation = StellarSignatureSchema.safeParse(config.signature);
        if (!sigValidation.success) {
            throw new InvalidSignature(sigValidation.error.issues[0].message);
        }

        const sigBytes = hexToBytes(config.signature.slice(2));
        const saltBytes = utf8ToBytes(STELLAR_ROOT_SALT);
        const infoBytes = utf8ToBytes(STELLAR_ROOT_INFO);

        try {
            return hkdf(sha256, sigBytes, saltBytes, infoBytes, 32);
        } finally {
            sigBytes.fill(0);
        }
    }

    /**
     * Turns 32 raw HKDF-derived bytes into an X25519 keypair (RFC 7748 clamping) — used for both
     * the viewing key inside `deriveKeys` and `derivePaymentRequestKeyPair`'s output, since a
     * payment-request key is just another HKDF-derived scalar on the account's viewing-key curve.
     */
    protected keyPairFromBytes(rawBytes: Uint8Array): KeyPair {
        const privateKey = clampToCurve25519(rawBytes);
        const privBytes = hexToBytes(privateKey.slice(2));
        const publicKeyBytes = x25519.getPublicKey(privBytes);
        const publicKey = ("0x" + bytesToHex(publicKeyBytes)) as Hex;
        privBytes.fill(0);
        return { privateKey, publicKey };
    }
}
