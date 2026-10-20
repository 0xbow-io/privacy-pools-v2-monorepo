import type {
    RelayedRegistrationAuthorization,
    Address,
    Eip712TypedData,
    Hash,
    Hex,
    IContractInteractor,
    LeafCacheSeed,
    PreparedTransaction,
} from "../internal.js";

/**
 * Interactions with the Keystore contract, generic over the chain's prepared-transaction type
 * `TTx` and address type `TAddress` (both default to their EVM shapes; no proof-type generic
 * here — Keystore operations never take a ZK proof).
 */
export interface IKeystoreInteractor<TTx = PreparedTransaction, TAddress = Address>
    extends IContractInteractor<TAddress> {
    /**
     * Reads the nullifying key hash registered for an account.
     *
     * @param account - The account address to query.
     * @returns The Poseidon hash of the nullifying key, or the zero hash if not registered.
     * @throws {ContractInteractorBaseError}
     */
    getNullifyingKeyHash(account: TAddress): Promise<Hash>;

    /**
     * Reads the viewing key registered for an account.
     *
     * @param account - The account address to query.
     * @returns The viewing public key (bytes32), or the zero hash if not registered.
     * @throws {ContractInteractorBaseError}
     */
    getViewingKey(account: TAddress): Promise<Hash>;

    /**
     * Checks whether a Merkle root is in the Keystore's root history buffer.
     *
     * @param root - The keystore root to verify.
     * @returns True if the root is recognized.
     * @throws {ContractInteractorBaseError}
     */
    isKnownRoot(root: Hash): Promise<boolean>;

    /**
     * Reads all key registry tree leaves from the Keystore contract.
     *
     * @returns Array of key registry leaf hashes.
     * @throws {ContractInteractorBaseError}
     */
    getKeystoreLeaves(): Promise<Hash[]>;

    /**
     * Returns the current keystore leaf cache state for external persistence
     * (e.g. to disk between test runs, or browser storage across dApp
     * sessions), or `undefined` if {@link getKeystoreLeaves} has never been
     * called on this instance. Feed the result back in as `seed` on a future
     * instance's constructor dependencies to skip re-scanning the leaves it
     * already covers.
     *
     * @returns The current cache snapshot, or `undefined` if nothing cached yet.
     */
    exportLeafCache(): LeafCacheSeed | undefined;

    /**
     * Returns the most-recent on-chain `authDigest` for the given account.
     *
     * Scans `AuthPolicySet` (first registration) and `AuthPolicyUpdated` (subsequent
     * rotations) events filtered by `_account`, sorts by block + log index, and
     * returns the latest digest. Used by revocable-key index discovery during
     * wallet cold-start recovery.
     *
     * @param account - The Ethereum address to query.
     * @returns The latest auth digest, or `null` when the account has never registered.
     * @throws {ContractInteractorBaseError}
     */
    getCurrentAuthorizerDigest(account: TAddress): Promise<Hash | null>;

    /**
     * Encodes a setAuthPolicy transaction without sending.
     *
     * @param authDigest - The authorization digest.
     * @param nullifyingKeyHash - The nullifying key hash.
     * @param sequenceOffset - Chain-specific hint for strictly-sequential networks (e.g.
     *   Soroban); see {@link IKeystoreChainAdapter.encodeSetAuthPolicy}'s doc comment.
     * @returns A prepared transaction ready for submission.
     */
    encodeSetAuthPolicy(authDigest: Hash, nullifyingKeyHash: Hash, sequenceOffset?: number): Promise<TTx>;

    /**
     * Encodes a setViewingKey transaction without sending.
     *
     * @param viewingKey - The X25519 viewing public key (32 bytes, 0x-prefixed).
     * @param sequenceOffset - Chain-specific hint for strictly-sequential networks (e.g.
     *   Soroban); see {@link IKeystoreChainAdapter.encodeSetAuthPolicy}'s doc comment.
     * @returns A prepared transaction ready for submission.
     */
    encodeSetViewingKey(viewingKey: Hex, sequenceOffset?: number): Promise<TTx>;

    /**
     * Encodes an updateAuthPolicy transaction without sending. The keystore contract
     * recomputes the old leaf as `Poseidon(msg.sender, nullifyingKeyHash, oldAuthDigest)`
     * and verifies it sits at `siblingNodes` against the current keystore root before
     * replacing it.
     *
     * @param oldAuthDigest - The currently-registered authorization digest.
     * @param newAuthDigest - The new authorization digest to install.
     * @param siblingNodes - Sibling hashes along the path from the old leaf to the root,
     *   padded to keystore tree depth.
     * @returns A prepared transaction ready for submission.
     */
    encodeUpdateAuthPolicy(
        oldAuthDigest: Hash,
        newAuthDigest: Hash,
        siblingNodes: Hash[],
    ): Promise<TTx>;

    /**
     * Sends a prepared transaction through the attached wallet.
     *
     * @param tx - The prepared transaction (to, data, value).
     * @returns The transaction hash.
     * @throws {ContractInteractorBaseError}
     */
    submitTransaction(tx: TTx): Promise<Hex>;

    /**
     * Signs an EIP-712 typed-data payload through the attached wallet. Used by the relayed
     * keystore-registration path to authorize `setAuthPolicyWithSig` off-chain.
     *
     * @param typedData - The resolved EIP-712 payload.
     * @returns The 65-byte signature as 0x-prefixed hex.
     * @throws {ContractInteractorBaseError}
     */
    signTypedData(typedData: Eip712TypedData): Promise<Hex>;

    /**
     * Builds what the account signs to let a relayer register it — see
     * {@link IKeystoreChainAdapter.buildRegistrationAuthorization}.
     *
     * @throws {ContractInteractorBaseError}
     */
    buildRegistrationAuthorization(args: {
        account: TAddress;
        nullifyingKeyHash: Hash;
        authDigest: Hash;
        deadline: Hex;
        chainId: number;
    }): Promise<RelayedRegistrationAuthorization>;

    /**
     * Signs a relayed-registration authorization through the attached wallet — see
     * {@link IKeystoreChainAdapter.signRegistrationAuthorization}.
     *
     * @throws {ContractInteractorBaseError | WalletInteractorBaseError}
     */
    signRegistrationAuthorization(authorization: RelayedRegistrationAuthorization): Promise<Hex>;
}
