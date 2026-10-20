import type {
    Address,
    DeriveFromSignatureConfig,
    Hex,
    PreparedRelayedRegistration,
    PreparedTransaction,
    RegisterKeystoreOptions,
    RegisterKeystoreResult,
    RelayedRegistrationOptions,
    RotateRevocableKeyConfig,
    RotateRevocableKeyOutcome,
    RotateRevocableKeyResult,
    SetAuthPolicyTypedData,
    TxLog,
    TxReceipt,
} from "../internal.js";

/**
 * Orchestrates the one-time keystore registration flow. Generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, log type `TLog`, and
 * signature-derivation config type `TDeriveConfig` (all default to their EVM shapes).
 */
export interface IPoolSessionKeystore<
    TTx = PreparedTransaction,
    TAddress = Address,
    TLog = TxLog,
    TDeriveConfig = DeriveFromSignatureConfig,
> {
    /**
     * Checks whether the account is already registered on-chain.
     *
     * @returns `true` if the account is already registered, `false` otherwise.
     * @throws {PoolSessionKeystoreBaseError} When the on-chain check fails.
     */
    isKeystoreRegistered(): Promise<boolean>;

    /**
     * Prepares calldata for the full keystore registration flow.
     *
     * Checks on-chain registration status first. If already registered,
     * returns a result with `alreadyRegistered: true` and `null` calldata.
     *
     * Otherwise computes `nullifyingKeyHash` and `authDigest` via the
     * injected `IHashService`, then encodes calldata for `setAuthPolicy`
     * and (by default) `setViewingKey`.
     *
     * The caller is responsible for submitting the returned transactions and,
     * after on-chain confirmation, calling `keystoreManager.markRegistered(chainId)`.
     *
     * @param options - Optional registration options.
     * @returns The prepared registration calldata and computed key hashes.
     * @throws {PoolSessionKeystoreBaseError} When the registration check or preparation fails.
     */
    prepareRegisterKeystore(options?: RegisterKeystoreOptions): Promise<RegisterKeystoreResult<TTx>>;

    /**
     * Prepares a RELAYED auth-policy registration: computes `nullifyingKeyHash` and
     * `authDigest`, builds the EIP-712 `setAuthPolicyWithSig` payload bound to the Keystore
     * contract, and (unless `sign: false`) signs it with the wired wallet.
     *
     * Unlike {@link prepareRegisterKeystore} this produces NO calldata — a relayer submits
     * `setAuthPolicyWithSig` (standalone) or `PrivacyPoolRelay.registerAndRelay` (atomic) on
     * the account's behalf, so the account never needs gas. The returned values
     * (`account`, `authDigest`, `nullifyingKeyHash`, `deadline`, `signature`) are the relayer
     * inputs; `typedData` is exposed so an integrator can sign externally when `sign: false`.
     *
     * Rejects an account that is already registered on-chain (a plain relayed withdrawal should
     * be used instead) and a `deadline` already in the past, before doing any signing.
     *
     * @param options - Deadline and signing options.
     * @returns The signed (or unsigned) relayed-registration payload.
     * @throws {PoolSessionKeystoreBaseError} When the account is already registered, the deadline is in the past, or signing fails.
     */
    prepareRelayedRegistration(
        options: RelayedRegistrationOptions,
    ): Promise<PreparedRelayedRegistration<TAddress>>;

    /**
     * Builds the EIP-712 `SetAuthPolicy` typed-data payload for a relayed registration,
     * bound to the given signature `deadline`. The integrator signs it with the account's
     * wallet and passes the signature to {@link IPoolSessionWithdraw.registerAndWithdraw}.
     * The domain and struct (account, authDigest, nullifyingKeyHash, deadline) match the
     * on-chain `Keystore` exactly. Always EVM-shaped (see {@link SetAuthPolicyTypedData}'s
     * doc) regardless of this interface's `TAddress`.
     *
     * @param deadline - Unix-seconds deadline after which the authorization is rejected
     *   on-chain (`Keystore_SignatureExpired`), as 0x-prefixed hex.
     * @returns The EIP-712 typed-data object to sign.
     */
    buildSetAuthPolicyTypedData(deadline: Hex): SetAuthPolicyTypedData;

    /**
     * Prepares and executes the full keystore registration flow in one step.
     *
     * @param options - Optional registration options.
     * @returns Array of on-chain transaction receipts (one per submitted tx).
     * @throws {PoolSessionKeystoreBaseError}
     */
    registerKeystore(options?: RegisterKeystoreOptions): Promise<TxReceipt<TLog>[]>;

    /**
     * Executes a previously prepared keystore registration by submitting the transactions on-chain.
     *
     * @param result - The result from prepareRegisterKeystore.
     * @returns Array of on-chain transaction receipts (one per submitted tx).
     * @throws {PoolSessionKeystoreBaseError}
     */
    executeRegisterKeystore(result: RegisterKeystoreResult<TTx>): Promise<TxReceipt<TLog>[]>;

    /**
     * Returns the rotation index of the active `privateRevocableKey`. Mirrors
     * {@link IKeystoreManager.getRevocableKeyIndex} on the facade so integrators
     * can read the current index without holding a `KeystoreManager` reference.
     */
    getRevocableKeyIndex(): Hex;

    /**
     * Scans on-chain `authorizerDigest` against candidate `privateRevocableKey_n`
     * values derived from the supplied wallet signature, returning the active
     * rotation index. Used during cold-start recovery when the integrator no
     * longer has the persisted index (e.g. wiped local storage).
     *
     * Reads the latest `authDigest` for `signerAddress` from `AuthPolicySet` /
     * `AuthPolicyUpdated` events, then for `n = 0..gapLimit` re-derives
     * `privateRevocableKey_n` and compares
     * `Poseidon(0, Poseidon(privateRevocableKey_n))` against the on-chain digest.
     *
     * @param config - Same shape as `deriveKeysFromSignature` minus `revocableKeyIndex`.
     * @param gapLimit - Highest candidate index scanned (exclusive). Defaults to
     *   {@link DEFAULT_REVOCABLE_KEY_GAP_LIMIT} (20).
     * @returns The matching rotation index `n`.
     * @throws {PoolSessionKeystoreBaseError}
     */
    discoverRevocableKeyIndex(
        config: Omit<TDeriveConfig, "revocableKeyIndex">,
        gapLimit?: number,
    ): Promise<Hex>;

    /**
     * Prepares the calldata + freshly derived key for a revocable-key rotation.
     * Increments the current rotation index by one, re-derives the new key from the
     * wallet signature, assembles the keystore inclusion proof for the current leaf,
     * and encodes the `updateAuthPolicy` transaction. Submission stays with the
     * caller — pass the returned result to {@link executeRotateRevocableKey} (or
     * sign and broadcast the calldata yourself, then call
     * {@link IKeystoreManager.applyRotation}).
     *
     * @param config - Same shape as `deriveKeysFromSignature` minus `revocableKeyIndex`.
     * @returns The prepared rotation result.
     * @throws {PoolSessionKeystoreBaseError}
     */
    prepareRotateRevocableKey(
        config: RotateRevocableKeyConfig<TDeriveConfig>,
    ): Promise<RotateRevocableKeyResult<TTx>>;

    /**
     * Submits a prepared rotation. On a successful receipt applies the rotation to
     * the in-memory {@link IKeystoreManager} so SDK state stays aligned with chain.
     *
     * @param result - Result returned by {@link prepareRotateRevocableKey}.
     * @returns The rotation outcome (receipt + superseded/active digests).
     * @throws {PoolSessionKeystoreBaseError}
     */
    executeRotateRevocableKey(
        result: RotateRevocableKeyResult<TTx>,
    ): Promise<RotateRevocableKeyOutcome<TLog>>;

    /**
     * Prepares and executes a revocable-key rotation in one call.
     *
     * @param config - Same shape as `deriveKeysFromSignature` minus `revocableKeyIndex`.
     * @returns The rotation outcome (receipt + superseded/active digests).
     * @throws {PoolSessionKeystoreBaseError}
     */
    rotateRevocableKey(
        config: RotateRevocableKeyConfig<TDeriveConfig>,
    ): Promise<RotateRevocableKeyOutcome<TLog>>;
}
