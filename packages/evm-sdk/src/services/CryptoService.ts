import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak256, parseSignature, toBytes } from "viem";

// `extends` needs the base class value synchronously at module-evaluation time. Going through
// this package's own `../internal.js` barrel still creates a circular import here (internal.ts
// -> services/index.ts -> this file -> internal.ts) that leaves `AbstractCryptoService` undefined
// at class-evaluation time, exactly like the same-directory case this comment originally
// described in packages/sdk — only now the cycle runs through the local barrel instead of a
// same-directory sibling. Importing directly from the dependency's own package entry (no cycle:
// core-sdk never imports evm-sdk) is the fix, mirroring the original same-directory workaround.
import { AbstractCryptoService } from "@privacy-pools-v2/core-sdk";
import {
    AddressSchema,
    APP_IDENTIFIER,
    clampToCurve25519,
    DerivedKeyMaterial,
    DeriveFromSignatureConfig,
    ECDHComputationError,
    Hex,
    InvalidAddress,
    InvalidPrivateKey,
    InvalidPublicKey,
    InvalidSignature,
    KeyPair,
    PayloadAddressHashMismatch,
    PublicKeySchema,
    ROOT_DERIVATION_INFO,
    Secret,
    SignatureSchema,
    ViewingPrivateKeySchema,
} from "../internal.js";

/**
 * EVM implementation of {@link ICryptoService} (via {@link AbstractCryptoService}). Uses
 * X25519 for ECDH and the viewing-key curve, XChaCha20-Poly1305 for symmetric encryption
 * (inherited), and derives protocol keys from an EIP-712 ECDSA signature.
 */
export class CryptoService extends AbstractCryptoService {
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

        const validatedPubKey = PublicKeySchema.safeParse(publicKey);
        if (!validatedPubKey.success) {
            throw new InvalidPublicKey(
                `Invalid Public Key: ${validatedPubKey.error.issues[0].message}`,
            );
        }

        let sharedSecret: Uint8Array;
        try {
            sharedSecret = x25519.getSharedSecret(validatedPrivKey.data, validatedPubKey.data);
        } catch (error) {
            throw new ECDHComputationError(error instanceof Error ? error.message : String(error));
        }

        // RFC 7748 §6.1: an all-zero output indicates a low-order / non-contributory
        // public key. Continuing would yield a constant, publicly-known
        // SHA-256(zeros) encryption key — everyone could decrypt our ciphertext.
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
     * @throws {InvalidSignature} When the signature is not 65 bytes.
     * @throws {InvalidAddress} When the signer address is not 20 bytes.
     * @throws {PayloadAddressHashMismatch} When `config.addressHash` does not equal
     *   `keccak256(signerAddress)`.
     */
    deriveKeysFromSignature(config: DeriveFromSignatureConfig): DerivedKeyMaterial {
        const rootSecret = this.deriveRootSecret(config);
        const appSecretBytes = this.deriveAppSecret(rootSecret, utf8ToBytes(APP_IDENTIFIER));

        try {
            return this.deriveKeys(appSecretBytes, BigInt(config.revocableKeyIndex));
        } finally {
            // rootSecret and appSecret MUST NOT persist beyond this call.
            rootSecret.fill(0);
            appSecretBytes.fill(0);
        }
    }

    /**
     * Stage 1 of the signature-based derivation: validates the signature/address, binds the
     * signature to `config.signerAddress` (spec Step 4), extracts the ECDSA `r` value as IKM,
     * then rootSecret = HKDF-SHA256(ikm=r, salt=signerAddress, info=ROOT_DERIVATION_INFO, L=32).
     * Output is ephemeral and MUST be zeroized by the caller.
     */
    protected deriveRootSecret(config: DeriveFromSignatureConfig): Uint8Array {
        const sigValidation = SignatureSchema.safeParse(config.signature);
        if (!sigValidation.success) {
            throw new InvalidSignature(sigValidation.error.issues[0].message);
        }
        const addrValidation = AddressSchema.safeParse(config.signerAddress);
        if (!addrValidation.success) {
            throw new InvalidAddress(addrValidation.error.issues[0].message);
        }

        // Bind signature to this signer (spec Step 4): if the caller provides the payload's
        // addressHash, verify it matches keccak256(signerAddress). Prevents use of a
        // signature produced for a payload that targets a different address.
        const expectedAddressHash = keccak256(toBytes(config.signerAddress));
        if (config.addressHash !== expectedAddressHash) {
            throw new PayloadAddressHashMismatch(
                "EIP-712 message.addressHash does not equal keccak256(signerAddress)",
            );
        }

        // Extract r value as IKM
        const sig = parseSignature(config.signature);
        const rValue = sig.r;
        sig.s = null!; // Destroy s component
        sig.v = null!; // Destroy v component

        const rBytes = hexToBytes(rValue.slice(2));
        const saltBytes = hexToBytes(config.signerAddress.slice(2));
        const infoBytes = utf8ToBytes(ROOT_DERIVATION_INFO);

        try {
            return hkdf(sha256, rBytes, saltBytes, infoBytes, 32);
        } finally {
            rBytes.fill(0);
        }
    }

    /**
     * Turns 32 raw HKDF-derived bytes into an X25519 keypair (RFC 7748 clamping).
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
