import { KeyPair } from "./DerivedKeys.js";
import { Hex } from "./Hex.js";
import { PublicKey } from "./PublicKey.js";
import { Secret } from "./Secret.js";

/** Configuration for constructing a {@link KeystoreManager}. All keys are pre-derived. */
export interface KeystoreManagerConfig {
    /** The private nullifying key used for deriving nullifiers (32-byte hex, 0x-prefixed). */
    privateNullifyingKey: Secret;
    /** The private revocable key used for authorization digests (32-byte hex, 0x-prefixed). */
    privateRevocableKey: Secret;
    /** The viewing private key for decrypting received notes (32-byte hex, 0x-prefixed). */
    viewingPrivateKey: Secret;
    /**
     * The public key corresponding to `viewingPrivateKey`, on whichever curve `curve` selects:
     * a 32-byte X25519 public key, or a 33-byte compressed secp256k1 public key.
     */
    viewingPublicKey: PublicKey;
    /**
     * Rotation index `n` of `privateRevocableKey`, encoded as 0x-prefixed hex. Must match the
     * index the key was derived under: `HKDF-Expand(identityPRK, "AUTH0:REVOCABLE" ‖ u64be(n), 48)`.
     * Required so the caller cannot silently fall back to index 0 after rotating — pass the
     * recovered index explicitly.
     */
    revocableKeyIndex: Hex;
    /**
     * The viewing key's curve — determines how `viewingPublicKey` is recomputed from
     * `viewingPrivateKey` for the constructor's mismatch check. Defaults to `"x25519"` (EVM's
     * viewing-key curve); Stellar's `StellarCryptoService` derives `"secp256k1"` viewing keys
     * instead (see the reference implementation's deviations notes, INTL-15) and must pass it explicitly.
     */
    curve?: "x25519" | "secp256k1";
}

/** A viewing key pair: X25519 private scalar + X25519 32-byte public key. */
export type ViewingKeyPair = KeyPair;
