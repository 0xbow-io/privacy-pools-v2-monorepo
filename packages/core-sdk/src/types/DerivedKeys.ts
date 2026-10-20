import { Address } from "./Address.js";
import { Hex } from "./Hex.js";
import { Secret } from "./Secret.js";

/**
 * Keys derived for a user/scheme: nullifier, revocation, and viewing. All are hex secrets.
 */
export interface DerivedKeys {
    /** The private nullifying key used for deriving note nullifiers. */
    privateNullifyingKey: Secret;
    /** The private revocable key used for authorization (can be rotated). */
    privateRevocableKey: Secret;
    /** The private viewing key used to decrypt notes sent to this account. */
    viewingPrivateKey: Secret;
}

/**
 * Full key material returned by the HKDF derivation: the three private keys plus the
 * X25519 public key corresponding to the viewing private key.
 * Matches the shape expected by {@link KeystoreManagerConfig}.
 */
export type DerivedKeyMaterial = DerivedKeys & {
    /** X25519 public key for the viewing key (32 bytes, no prefix byte). */
    viewingPublicKey: Hex;
};

/**
 * A key pair consisting of a private key and its corresponding public key.
 */
export interface KeyPair {
    privateKey: Secret;
    publicKey: Hex;
}

/**
 * Config for {@link ICryptoService.deriveKeysFromSignature}.
 * Integrator produces (signature, signerAddress) via wallet's signTypedData (EIP-712 recommended);
 * SDK extracts `r`, runs 2-stage HKDF to reach the appSecret, then the layered HKDF tree.
 */
export interface DeriveFromSignatureConfig {
    /** 65-byte ECDSA signature as 0x-prefixed hex. */
    signature: Hex;
    /** EVM address (20 bytes) that produced the signature. Used as HKDF salt in the root stage. */
    signerAddress: Address;
    /**
     * Rotation index for the revocable key (0x-prefixed hex of a u64). REQUIRED. Pass `"0x0"`
     * for a fresh account; pass the persisted value when re-hydrating an account that has
     * rotated. Required at the type level so callers cannot silently fall back to index 0
     * after rotation.
     */
    revocableKeyIndex: Hex;
    /**
     * The `message.addressHash` field from the signed EIP-712 payload. SDK verifies it equals
     * `keccak256(signerAddress)` before derivation — catches payloads constructed for a
     * different signer (integrator-bug / replay defence, per spec Step 4).
     */
    addressHash: Hex;
}

/**
 * Config for {@link ICryptoService.deriveKeysFromSignature} on Stellar. Integrator produces a
 * deterministic ed25519 signature over a fixed derivation message via the wallet; SDK derives
 * the chain-specific rootSecret (Stellar-only salt/info — see {@link StellarCryptoService}'s
 * class doc), then reuses `AbstractCryptoService`'s shared appSecret/layered-HKDF-tree stages —
 * the same ones EVM uses.
 *
 * Unlike {@link DeriveFromSignatureConfig}, there is no signer-binding field analogous to
 * `addressHash`: the upstream reference implementation has no such check, and the fixed
 * derivation message's exact wire format (which would be the natural place to embed a signer
 * identity to bind against) is still-undesigned wallet-signing UX, tracked separately. A caller
 * supplying a signature intended for a different derivation is not currently guarded against.
 */
export interface StellarDeriveFromSignatureConfig {
    /** Raw 64-byte ed25519 signature over a fixed derivation message, as 0x-prefixed hex. */
    signature: Hex;
    /**
     * Domain separator for the app/deployment, used as the HKDF salt for the shared appSecret
     * stage (`AbstractCryptoService.deriveAppSecret`) — same role as EVM's `APP_IDENTIFIER`
     * constant, but supplied per-call here rather than hardcoded. Empty string is valid.
     */
    appIdentifier: string;
    /**
     * Rotation index for the revocable key (0x-prefixed hex of a u64). REQUIRED. Pass `"0x0"`
     * for a fresh account; pass the persisted value when re-hydrating an account that has
     * rotated.
     */
    revocableKeyIndex: Hex;
}
