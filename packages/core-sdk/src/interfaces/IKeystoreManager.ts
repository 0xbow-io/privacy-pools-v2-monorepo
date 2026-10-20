import { Hex, Secret, ViewingKeyPair } from "../internal.js";

/** Contract for managing cryptographic key material for a Privacy Pools account. */
export interface IKeystoreManager {
    /**
     * Returns the private nullifying key used for nullifier derivation.
     * @returns The private nullifying key as 0x-prefixed hex.
     */
    getPrivateNullifyingKey(): Secret;

    /**
     * Returns the current private revocable key.
     * @returns The private revocable key as 0x-prefixed hex.
     */
    getPrivateRevocableKey(): Secret;

    /**
     * Returns the rotation index of the current `privateRevocableKey`.
     * @returns The u64 rotation index `n` as 0x-prefixed hex, such that the active key was
     *   derived under `HKDF-Expand(identityPRK, "AUTH0:REVOCABLE" ‖ u64be(n), 48)`.
     */
    getRevocableKeyIndex(): Hex;

    /**
     * Returns the viewing key pair (X25519 private key + 32-byte X25519 public key).
     * @returns The viewing key pair.
     */
    getViewingKeyPair(): ViewingKeyPair;

    /**
     * Replaces the stored revocable key + index with a pre-derived pair. Intended for
     * callers (typically {@link IPoolSessionKeystore.executeRotateRevocableKey}) that
     * already derived the new key during preparation and only need to commit the
     * rotation in-memory after on-chain confirmation.
     *
     * @param newIndex - Target rotation index. MUST be strictly greater than the current index.
     * @param newKey - The pre-derived `privateRevocableKey` for `newIndex`.
     * @throws {KeystoreManagerBaseError} When `newIndex` is not strictly greater than the current index.
     */
    applyRotation(newIndex: Hex, newKey: Secret): void;

    /**
     * Checks whether the account has been registered on the given chain.
     * @param chainId - The chain ID to check.
     * @returns `true` if the account is registered on the chain, `false` otherwise.
     */
    isRegistered(chainId: number): boolean;

    /**
     * Marks the account as registered on the given chain.
     * @param chainId - The chain ID to mark as registered.
     * @throws {KeystoreManagerError} When the account is already registered on the given chain.
     */
    markRegistered(chainId: number): void;
}
