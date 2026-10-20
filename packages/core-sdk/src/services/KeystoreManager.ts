import { hexToBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
    AlreadyRegistered,
    bigintToHex,
    bytesToBigIntBE,
    DeriveFromSignatureConfig,
    Hex,
    ICryptoService,
    IKeystoreManager,
    InvalidKeystoreManagerConfig,
    InvalidRotationIndex,
    KeystoreManagerConfig,
    KeystoreManagerConfigSchema,
    Secret,
    ViewingKeyPair,
} from "../internal.js";

/**
 * Stateful owner of all cryptographic key material for a Privacy Pools account.
 * Pure state container — no hashing, no contract interaction.
 *
 * Keys may be supplied directly via the constructor or derived from a wallet signature
 * (EIP-712 recommended) via the {@link KeystoreManager.fromSignature} static factory.
 */
export class KeystoreManager implements IKeystoreManager {
    private readonly privateNullifyingKey: Secret;
    private privateRevocableKey: Secret;
    private revocableKeyIndex: bigint;
    private readonly viewingPrivateKey: Secret;
    private readonly viewingPublicKey: Secret;
    private readonly registeredChains = new Set<number>();

    /**
     * Creates a KeystoreManager by deriving all three protocol keys from a wallet signature.
     * Delegates to {@link ICryptoService.deriveKeysFromSignature} (two-stage HKDF).
     * @param config - `{ signature, signerAddress, revocableKeyIndex }`. `revocableKeyIndex` MUST
     *   be supplied — pass `0n` for a fresh account, or the persisted value when re-hydrating an
     *   account that has rotated. The SDK does not discover the index from chain; it is the
     *   integrator's responsibility to persist it alongside the rest of the account state.
     * @param dependencies - Required dependencies; must include a `cryptoService` instance.
     * @throws {InvalidSignature} When the signature is not 65 bytes.
     * @throws {InvalidAddress} When the signer address is not 20 bytes.
     */
    static fromSignature(
        config: DeriveFromSignatureConfig,
        dependencies: { cryptoService: ICryptoService },
    ): KeystoreManager {
        const derived = dependencies.cryptoService.deriveKeysFromSignature(config);
        return new KeystoreManager({
            privateNullifyingKey: derived.privateNullifyingKey,
            privateRevocableKey: derived.privateRevocableKey,
            viewingPrivateKey: derived.viewingPrivateKey,
            viewingPublicKey: derived.viewingPublicKey,
            revocableKeyIndex: config.revocableKeyIndex,
        });
    }

    /**
     * Creates a new KeystoreManager instance.
     * @param config - The keystore configuration with all pre-derived keys.
     * @throws {InvalidKeystoreManagerConfig} If the config fails schema
     *   validation, or if `viewingPublicKey` does not match the recomputed public key on
     *   `config.curve` (`"x25519"` by default; Stellar passes `"secp256k1"`) — a mismatched pair
     *   would break note decryption and ASP ciphertext processing (incoming notes encrypted to
     *   the wrong public key are undecryptable; deposit ASP ciphertexts the ASP cannot decrypt
     *   are dropped from the association set, blocking spends).
     */
    constructor(config: KeystoreManagerConfig) {
        const result = KeystoreManagerConfigSchema.safeParse(config);
        if (!result.success) {
            throw new InvalidKeystoreManagerConfig(result.error.issues[0].message);
        }

        const curve = config.curve ?? "x25519";
        const privateKeyBytes = hexToBytes(config.viewingPrivateKey.slice(2));
        const derivedPub =
            curve === "x25519"
                ? x25519.getPublicKey(privateKeyBytes)
                : secp256k1.getPublicKey(privateKeyBytes, true);
        const suppliedPub = hexToBytes(config.viewingPublicKey.slice(2));
        if (bytesToBigIntBE(derivedPub) !== bytesToBigIntBE(suppliedPub)) {
            throw new InvalidKeystoreManagerConfig(
                `viewingPublicKey does not match ${curve}.getPublicKey(viewingPrivateKey)`,
            );
        }

        this.privateNullifyingKey = config.privateNullifyingKey;
        this.privateRevocableKey = config.privateRevocableKey;
        this.revocableKeyIndex = BigInt(config.revocableKeyIndex);
        this.viewingPrivateKey = config.viewingPrivateKey;
        this.viewingPublicKey = config.viewingPublicKey;
    }

    /** @inheritdoc IKeystoreManager.getPrivateNullifyingKey */
    getPrivateNullifyingKey(): Secret {
        return this.privateNullifyingKey;
    }

    /** @inheritdoc IKeystoreManager.getPrivateRevocableKey */
    getPrivateRevocableKey(): Secret {
        return this.privateRevocableKey;
    }

    /** @inheritdoc IKeystoreManager.getRevocableKeyIndex */
    getRevocableKeyIndex(): Hex {
        return bigintToHex(this.revocableKeyIndex);
    }

    /** @inheritdoc IKeystoreManager.getViewingKeyPair */
    getViewingKeyPair(): ViewingKeyPair {
        return {
            privateKey: this.viewingPrivateKey,
            publicKey: this.viewingPublicKey,
        };
    }

    /**
     * @inheritdoc IKeystoreManager.applyRotation
     * @throws {InvalidRotationIndex} When `newIndex` is not strictly greater than the current index.
     */
    applyRotation(newIndex: Hex, newKey: Secret): void {
        const newIndexBig = BigInt(newIndex);
        if (newIndexBig <= this.revocableKeyIndex) {
            throw new InvalidRotationIndex(this.revocableKeyIndex, newIndexBig);
        }
        this.privateRevocableKey = newKey;
        this.revocableKeyIndex = newIndexBig;
    }

    /** @inheritdoc IKeystoreManager.isRegistered */
    isRegistered(chainId: number): boolean {
        return this.registeredChains.has(chainId);
    }

    /** @inheritdoc IKeystoreManager.markRegistered */
    markRegistered(chainId: number): void {
        if (this.registeredChains.has(chainId)) {
            throw new AlreadyRegistered(chainId);
        }
        this.registeredChains.add(chainId);
    }
}
