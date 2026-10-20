import type {
    Address,
    DeriveFromSignatureConfig,
    Hex,
    IAddressFieldConverter,
    ICryptoService,
    IHashService,
    IKeystoreInteractor,
    IKeystoreManager,
    ILogger,
    IMerkleService,
    INoteComputationService,
    IPoolSessionKeystore,
    IPreparedTxVerifier,
    ITxReceiptWaiter,
    PoolSessionKeystoreConfig,
    PoolSessionKeystoreDependencies,
    PreparedRelayedRegistration,
    PreparedTransaction,
    RegisterKeystoreOptions,
    RegisterKeystoreResult,
    RelayedRegistrationOptions,
    RotateRevocableKeyConfig,
    RotateRevocableKeyOutcome,
    RotateRevocableKeyResult,
    Secret,
    SetAuthPolicyTypedData,
    TxLog,
    TxReceipt,
} from "../../internal.js";
import {
    bigintToHex,
    ContractInteractorBaseError,
    CurrentLeafNotFound,
    DEFAULT_REVOCABLE_KEY_GAP_LIMIT,
    isKeystoreRegisteredOnChain,
    InvalidPoolSessionKeystoreConfig,
    KEYSTORE_EIP712_DOMAIN_NAME,
    KEYSTORE_EIP712_DOMAIN_VERSION,
    KEYSTORE_MAX_DEPTH,
    KeystoreAlreadyRegistered,
    KeystoreNotRegistered,
    makePoolSessionKeystoreConfigSchema,
    PoolSessionKeystoreBaseError,
    RegistrationCheckFailed,
    RegistrationDeadlineInPast,
    RevocableKeyIndexNotFound,
    RotationKeyMismatch,
} from "../../internal.js";

/**
 * Default implementation of {@link IPoolSessionKeystore}, generic over the chain's
 * prepared-transaction type `TTx` and address type `TAddress`.
 *
 * `prepareRelayedRegistration` is chain-neutral: the keystore interactor builds and signs the
 * chain's authorization (EIP-712 on EVM, a Soroban auth entry on Stellar). The EVM-only
 * `buildSetAuthPolicyTypedData` stays concretely EVM-shaped (see `SetAuthPolicyTypedData`'s doc
 * comment), same "some internals stay concretely typed by design" pattern as `PoolSessionDeposit`.
 * `executeRegisterKeystore`/`executeRotateRevocableKey` verify prepared transactions via the
 * injected `preparedTxVerifier` ({@link IPreparedTxVerifier}) rather than an EVM-only guard
 * called directly.
 */
export class PoolSessionKeystore<
    TTx = PreparedTransaction,
    TAddress = Address,
    TLog = TxLog,
    TDeriveConfig = DeriveFromSignatureConfig,
> implements IPoolSessionKeystore<TTx, TAddress, TLog, TDeriveConfig>
{
    private readonly ownerAddress: TAddress;
    private readonly chainId: number;
    private readonly keystoreManager: IKeystoreManager;
    private readonly keystoreInteractor: IKeystoreInteractor<TTx, TAddress>;
    private readonly noteComputationService: INoteComputationService;
    private readonly hashService: IHashService;
    private readonly merkleService: IMerkleService;
    private readonly cryptoService: ICryptoService<TDeriveConfig>;
    private readonly rpcInteractor: ITxReceiptWaiter<TLog>;
    private readonly preparedTxVerifier: IPreparedTxVerifier<TTx, TAddress>;
    private readonly addressFieldConverter: IAddressFieldConverter<TAddress>;
    private readonly logger?: ILogger;

    /**
     * @throws {InvalidPoolSessionKeystoreConfig} When config validation fails.
     */
    constructor(
        config: PoolSessionKeystoreConfig<TTx, TAddress, TLog, TDeriveConfig>,
        deps?: PoolSessionKeystoreDependencies,
    ) {
        const configSchema = makePoolSessionKeystoreConfigSchema(config.addressSchema);
        const validated = configSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidPoolSessionKeystoreConfig(validated.error.issues[0].message);
        }

        this.ownerAddress = config.ownerAddress;
        this.chainId = config.chainId;
        this.keystoreManager = config.keystoreManager;
        this.keystoreInteractor = config.keystoreInteractor;
        this.noteComputationService = config.noteComputationService;
        this.hashService = config.hashService;
        this.merkleService = config.merkleService;
        this.cryptoService = config.cryptoService;
        this.rpcInteractor = config.rpcInteractor;
        this.preparedTxVerifier = config.preparedTxVerifier;
        this.addressFieldConverter = config.addressFieldConverter;
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionKeystore.isKeystoreRegistered
     * @throws {RegistrationCheckFailed} When the RPC call fails.
     */
    async isKeystoreRegistered(): Promise<boolean> {
        this.logger?.debug("Checking keystore registration", {
            owner: this.ownerAddress,
        });

        return isKeystoreRegisteredOnChain(this.keystoreInteractor, this.ownerAddress);
    }

    /**
     * @inheritdoc IPoolSessionKeystore.prepareRegisterKeystore
     * @throws {RegistrationCheckFailed} When the on-chain check fails.
     */
    async prepareRegisterKeystore(
        options?: RegisterKeystoreOptions,
    ): Promise<RegisterKeystoreResult<TTx>> {
        const includeViewingKey = options?.includeViewingKey ?? true;

        this.logger?.debug("Preparing keystore registration", {
            includeViewingKey,
        });

        const privateNullifyingKey = this.keystoreManager.getPrivateNullifyingKey();
        const privateRevocableKey = this.keystoreManager.getPrivateRevocableKey();
        const { publicKey: viewingPublicKey } = this.keystoreManager.getViewingKeyPair();

        const nullifyingKeyHash = this.computeNullifyingKeyHash(privateNullifyingKey);
        const authDigest = this.noteComputationService.computeAuthDigest(privateRevocableKey);

        const alreadyAuthRegistered = await this.isKeystoreRegistered();
        const alreadyViewingKeySet = includeViewingKey ? await this.isViewingKeySet() : true;

        if (alreadyAuthRegistered && alreadyViewingKeySet) {
            this.logger?.info("Keystore already registered, skipping");
            return {
                alreadyRegistered: true,
                keystoreCalldata: null,
                viewingKeyCalldata: null,
                nullifyingKeyHash,
                authDigest,
            };
        }

        const keystoreCalldata = await this.buildAuthPolicyCalldata(
            alreadyAuthRegistered,
            authDigest,
            nullifyingKeyHash,
        );
        // executeRegisterKeystore submits keystoreCalldata first and waits for its receipt
        // before submitting viewingKeyCalldata — but both are BUILT here, before either is
        // submitted. On a strictly-sequential network (Soroban), a viewing-key transaction built
        // right behind an unconfirmed auth-policy one needs to target one sequence number
        // further out, or it fails with a stale-sequence error once actually submitted (Evm
        // adapters ignore this hint — mempool nonce ordering already handles it there).
        const viewingKeyCalldata = await this.buildViewingKeyCalldata(
            includeViewingKey,
            alreadyViewingKeySet,
            viewingPublicKey,
            keystoreCalldata !== null ? 2 : 1,
        );

        this.logger?.info("Keystore registration prepared", {
            nullifyingKeyHash,
            authDigest,
            includeViewingKey,
            partialResumption: alreadyAuthRegistered,
        });

        return {
            alreadyRegistered: false,
            keystoreCalldata,
            viewingKeyCalldata,
            nullifyingKeyHash,
            authDigest,
        };
    }

    /**
     * @inheritdoc IPoolSessionKeystore.prepareRelayedRegistration
     * @throws {KeystoreAlreadyRegistered} When the account is already registered on-chain.
     * @throws {RegistrationDeadlineInPast} When `deadline` is not in the future.
     * @throws {RegistrationCheckFailed} When the on-chain registration check fails.
     * @throws {WalletNotAvailable} When `sign` is requested but no wallet is wired.
     */
    async prepareRelayedRegistration(
        options: RelayedRegistrationOptions,
    ): Promise<PreparedRelayedRegistration<TAddress>> {
        const { deadline } = options;
        const sign = options.sign ?? true;

        // Courtesy guard: `registerAndRelay` is idempotent for a matching key and reverts
        // (Keystore_AuthPolicyAlreadySet) for a mismatching one, so preparing a relayed
        // registration for an already-registered account only wastes proof-gen and relayer
        // gas. Reject it up front — the caller should use a plain relayed withdrawal.
        if (await this.isKeystoreRegistered()) {
            throw new KeystoreAlreadyRegistered(`${this.ownerAddress}`);
        }

        // Courtesy guard: the contract enforces `block.timestamp <= deadline`
        // (Keystore_SignatureExpired), so a past deadline would only surface as an on-chain
        // revert after the relayer spends gas. Reject it up front.
        const now = Math.floor(Date.now() / 1000);
        if (BigInt(deadline) <= BigInt(now)) {
            throw new RegistrationDeadlineInPast(deadline, now);
        }

        const privateNullifyingKey = this.keystoreManager.getPrivateNullifyingKey();
        const privateRevocableKey = this.keystoreManager.getPrivateRevocableKey();
        const nullifyingKeyHash = this.computeNullifyingKeyHash(privateNullifyingKey);
        const authDigest = this.noteComputationService.computeAuthDigest(privateRevocableKey);

        // The chain decides what the account signs (EIP-712 typed data on EVM, a Soroban auth
        // entry on Stellar); the checks above and the fields below are chain-neutral.
        const typedData = await this.keystoreInteractor.buildRegistrationAuthorization({
            account: this.ownerAddress,
            chainId: this.chainId,
            authDigest,
            nullifyingKeyHash,
            deadline,
        });

        const signature = sign ? await this.keystoreInteractor.signRegistrationAuthorization(typedData) : null;

        this.logger?.info("Prepared relayed keystore registration", {
            account: this.ownerAddress,
            nullifyingKeyHash,
            authDigest,
            deadline,
            signed: signature !== null,
        });

        return {
            typedData,
            account: this.ownerAddress,
            nullifyingKeyHash,
            authDigest,
            deadline,
            signature,
        };
    }

    /** @inheritdoc IPoolSessionKeystore.buildSetAuthPolicyTypedData */
    buildSetAuthPolicyTypedData(deadline: Hex): SetAuthPolicyTypedData {
        const nullifyingKeyHash = this.computeNullifyingKeyHash(
            this.keystoreManager.getPrivateNullifyingKey(),
        );
        const authDigest = this.noteComputationService.computeAuthDigest(
            this.keystoreManager.getPrivateRevocableKey(),
        );

        // Field order (account, authDigest, nullifyingKeyHash, deadline) MUST match the
        // on-chain `SET_AUTH_POLICY_TYPEHASH` and `SET_AUTH_POLICY_TYPES` exactly, or the
        // signature will not verify. `deadline` is the C-8 audit field bounding validity.
        return {
            domain: {
                name: KEYSTORE_EIP712_DOMAIN_NAME,
                version: KEYSTORE_EIP712_DOMAIN_VERSION,
                chainId: this.chainId,
                verifyingContract: this.keystoreInteractor.getAddress() as Address,
            },
            types: {
                SetAuthPolicy: [
                    { name: "account", type: "address" },
                    { name: "authDigest", type: "uint256" },
                    { name: "nullifyingKeyHash", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                ],
            },
            primaryType: "SetAuthPolicy",
            message: {
                account: this.ownerAddress as Address,
                authDigest: BigInt(authDigest),
                nullifyingKeyHash: BigInt(nullifyingKeyHash),
                deadline: BigInt(deadline),
            },
        };
    }

    /**
     * Reads the on-chain viewing key for this owner. Unset slots read as zero;
     * `Poseidon` is never zero for any preimage, so a zero result unambiguously
     * means "not set". Used to detect partial registration where setAuthPolicy
     * succeeded but setViewingKey failed (or hasn't run yet).
     *
     * @throws {RegistrationCheckFailed} When the on-chain read fails.
     */
    private async isViewingKeySet(): Promise<boolean> {
        try {
            const onChain = await this.keystoreInteractor.getViewingKey(this.ownerAddress);
            return BigInt(onChain) !== 0n;
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) {
                throw new RegistrationCheckFailed(error.message);
            }
            throw new RegistrationCheckFailed(
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    /**
     * Returns the auth-policy calldata, or `null` when the policy is already
     * registered on-chain (partial-resumption path).
     */
    private async buildAuthPolicyCalldata(
        alreadyAuthRegistered: boolean,
        authDigest: Hex,
        nullifyingKeyHash: Hex,
    ): Promise<TTx | null> {
        if (alreadyAuthRegistered) return null;
        return this.keystoreInteractor.encodeSetAuthPolicy(authDigest, nullifyingKeyHash);
    }

    /**
     * Returns the viewing-key calldata, or `null` when viewing-key registration
     * is opted out of or already present on-chain.
     */
    private async buildViewingKeyCalldata(
        includeViewingKey: boolean,
        alreadyViewingKeySet: boolean,
        viewingPublicKey: Hex,
        sequenceOffset: number,
    ): Promise<TTx | null> {
        if (!includeViewingKey) return null;
        if (alreadyViewingKeySet) return null;
        return this.keystoreInteractor.encodeSetViewingKey(viewingPublicKey, sequenceOffset);
    }

    /**
     * @inheritdoc IPoolSessionKeystore.registerKeystore
     */
    async registerKeystore(options?: RegisterKeystoreOptions): Promise<TxReceipt<TLog>[]> {
        const result = await this.prepareRegisterKeystore(options);
        return this.executeRegisterKeystore(result);
    }

    /**
     * @inheritdoc IPoolSessionKeystore.executeRegisterKeystore
     * @throws {UnexpectedTransactionTarget} If `keystoreCalldata` or `viewingKeyCalldata`
     *   does not call the expected Keystore function on the configured contract.
     */
    async executeRegisterKeystore(result: RegisterKeystoreResult<TTx>): Promise<TxReceipt<TLog>[]> {
        if (result.alreadyRegistered) return [];

        // Validate both transactions before signing either: a tampered setViewingKey must not be
        // discovered only after setAuthPolicy is already on-chain as a partial registration.
        if (result.keystoreCalldata) {
            this.preparedTxVerifier.assertMatches(result.keystoreCalldata, {
                to: this.keystoreInteractor.getAddress(),
                operation: "setAuthPolicy",
            });
        }
        if (result.viewingKeyCalldata) {
            this.preparedTxVerifier.assertMatches(result.viewingKeyCalldata, {
                to: this.keystoreInteractor.getAddress(),
                operation: "setViewingKey",
            });
        }

        const receipts: TxReceipt<TLog>[] = [];

        if (result.keystoreCalldata) {
            const authHash = await this.keystoreInteractor.submitTransaction(
                result.keystoreCalldata,
            );
            const authReceipt = await this.rpcInteractor.waitForTransactionReceipt(authHash);
            receipts.push(authReceipt);

            if (!authReceipt.status) {
                throw new PoolSessionKeystoreBaseError("setAuthPolicy transaction reverted");
            }
        }

        if (result.viewingKeyCalldata) {
            const vkHash = await this.keystoreInteractor.submitTransaction(
                result.viewingKeyCalldata,
            );
            const vkReceipt = await this.rpcInteractor.waitForTransactionReceipt(vkHash);
            receipts.push(vkReceipt);

            if (!vkReceipt.status) {
                throw new PoolSessionKeystoreBaseError("setViewingKey transaction reverted");
            }
        }

        // A resumed partial registration runs in a session that already marked itself after the
        // first (auth-policy) run; KeystoreManager.markRegistered rejects a second mark, and
        // throwing here would report failure for transactions that just succeeded on-chain.
        if (!this.keystoreManager.isRegistered(this.chainId)) {
            this.keystoreManager.markRegistered(this.chainId);
        }
        return receipts;
    }

    /** @inheritdoc IPoolSessionKeystore.getRevocableKeyIndex */
    getRevocableKeyIndex(): Hex {
        return this.keystoreManager.getRevocableKeyIndex();
    }

    /**
     * @inheritdoc IPoolSessionKeystore.discoverRevocableKeyIndex
     * @throws {KeystoreNotRegistered} If the account has never registered on-chain.
     * @throws {RevocableKeyIndexNotFound} If no candidate index in `[0, gapLimit)` matches.
     */
    async discoverRevocableKeyIndex(
        config: Omit<TDeriveConfig, "revocableKeyIndex">,
        gapLimit: number = DEFAULT_REVOCABLE_KEY_GAP_LIMIT,
    ): Promise<Hex> {
        this.logger?.debug("Discovering revocable key index", {
            owner: this.ownerAddress,
            gapLimit,
        });

        // The session's own `ownerAddress` — not `config.signerAddress` — is the account whose
        // on-chain authorizer digest is being scanned: a session is always keyed to a single
        // owner, and `config.signerAddress` is typed `Address` (EVM-shaped) regardless of
        // `TAddress`, so trusting it here silently broke a Stellar-shaped `config` (no such
        // field — `undefined` at runtime) that only compiled via method-parameter bivariance.
        const onChainDigest = await this.keystoreInteractor.getCurrentAuthorizerDigest(
            this.ownerAddress,
        );
        if (onChainDigest === null) {
            throw new KeystoreNotRegistered(`${this.ownerAddress}`);
        }

        for (let n = 0n; n < BigInt(gapLimit); n++) {
            const candidateIndex = bigintToHex(n);
            const derived = this.cryptoService.deriveKeysFromSignature({
                ...config,
                revocableKeyIndex: candidateIndex,
            } as TDeriveConfig);
            const candidateDigest = this.noteComputationService.computeAuthDigest(
                derived.privateRevocableKey,
            );
            if (BigInt(candidateDigest) === BigInt(onChainDigest)) {
                this.logger?.info("Revocable key index discovered", { index: n.toString() });
                return candidateIndex;
            }
        }

        throw new RevocableKeyIndexNotFound(gapLimit);
    }

    /**
     * @inheritdoc IPoolSessionKeystore.prepareRotateRevocableKey
     * @throws {KeystoreNotRegistered} If the account has not yet registered on-chain.
     * @throws {CurrentLeafNotFound} If the current leaf cannot be located in the on-chain tree.
     */
    async prepareRotateRevocableKey(
        config: RotateRevocableKeyConfig<TDeriveConfig>,
    ): Promise<RotateRevocableKeyResult<TTx>> {
        const newIndex = bigintToHex(BigInt(this.keystoreManager.getRevocableKeyIndex()) + 1n);

        this.logger?.debug("Preparing revocable key rotation", { newIndex });

        const ownerAddress = this.ownerAddress;
        const currentRevocableKey = this.keystoreManager.getPrivateRevocableKey();

        const nullifyingKeyHashOnChain =
            await this.keystoreInteractor.getNullifyingKeyHash(ownerAddress);
        // Sentinel: see `isKeystoreRegistered`. 0 ⇒ unregistered slot.
        if (BigInt(nullifyingKeyHashOnChain) === 0n) {
            throw new KeystoreNotRegistered(`${ownerAddress}`);
        }

        const oldAuthDigest = this.noteComputationService.computeAuthDigest(currentRevocableKey);

        const derived = this.cryptoService.deriveKeysFromSignature({
            ...config,
            revocableKeyIndex: newIndex,
        } as TDeriveConfig);
        const newRevocableKey = derived.privateRevocableKey;
        const newAuthDigest = this.noteComputationService.computeAuthDigest(newRevocableKey);

        // This calldata is the single carrier of the digests: executeRotateRevocableKey decodes
        // them back out after validation and rebuilds the Merkle path against the latest tree.
        const keystoreCalldata = await this.buildUpdateAuthPolicyCalldata(
            oldAuthDigest,
            newAuthDigest,
        );

        this.logger?.info("Revocable key rotation prepared", {
            oldAuthDigest,
            newAuthDigest,
            newIndex,
        });

        return {
            keystoreCalldata,
            newIndex,
            newRevocableKey,
        };
    }

    /**
     * @inheritdoc IPoolSessionKeystore.executeRotateRevocableKey
     * @throws {UnexpectedTransactionTarget} If `keystoreCalldata` does not call
     *   `updateAuthPolicy` on the configured Keystore contract.
     * @throws {RotationKeyMismatch} If `newRevocableKey` does not hash to the new
     *   authDigest inside `keystoreCalldata`.
     * @throws {CurrentLeafNotFound} If the caller's leaf is not in the current tree.
     */
    async executeRotateRevocableKey(
        result: RotateRevocableKeyResult<TTx>,
    ): Promise<RotateRevocableKeyOutcome<TLog>> {
        // The digests used below come from this validated calldata, not from loose result fields,
        // so the tamper guard covers everything that reaches the chain.
        const decoded = this.preparedTxVerifier.assertMatches(result.keystoreCalldata, {
            to: this.keystoreInteractor.getAddress(),
            operation: "updateAuthPolicy",
        });
        const [oldDigestWord, newDigestWord] = decoded.args as readonly [bigint, bigint];
        const oldAuthDigest = bigintToHex(oldDigestWord);
        const newAuthDigest = bigintToHex(newDigestWord);

        // applyRotation stores newRevocableKey locally after the transaction lands. If that key
        // does not hash to the digest going on-chain, the stored key can never authorize again.
        // Reject the mismatch before spending gas.
        const computedDigest = this.noteComputationService.computeAuthDigest(
            result.newRevocableKey,
        );
        if (BigInt(computedDigest) !== newDigestWord) {
            throw new RotationKeyMismatch(newAuthDigest, computedDigest);
        }

        // Rebuild the Merkle path against the latest keystore tree right before submitting — same
        // digests, fresh siblings. updateAuthPolicy verifies siblings against the exact current
        // root, so a path baked at prepare time reverts if an insertion landed since. Rebuilding
        // shrinks the stale window from prepare→execute down to fetch→inclusion.
        const keystoreCalldata = await this.buildUpdateAuthPolicyCalldata(
            oldAuthDigest,
            newAuthDigest,
        );
        const txHash = await this.keystoreInteractor.submitTransaction(keystoreCalldata);
        const receipt = await this.rpcInteractor.waitForTransactionReceipt(txHash);

        if (!receipt.status) {
            throw new PoolSessionKeystoreBaseError("updateAuthPolicy transaction reverted");
        }

        this.keystoreManager.applyRotation(result.newIndex, result.newRevocableKey);
        return {
            receipt,
            oldAuthorizerDigest: oldAuthDigest,
            newAuthorizerDigest: newAuthDigest,
            newRevocableKeyIndex: result.newIndex,
        };
    }

    /** @inheritdoc IPoolSessionKeystore.rotateRevocableKey */
    async rotateRevocableKey(
        config: RotateRevocableKeyConfig<TDeriveConfig>,
    ): Promise<RotateRevocableKeyOutcome<TLog>> {
        const prepared = await this.prepareRotateRevocableKey(config);
        return this.executeRotateRevocableKey(prepared);
    }

    /**
     * Builds the `updateAuthPolicy` calldata for a revocable-key rotation: re-reads the keystore
     * tree, locates the caller's current leaf, and embeds a fresh Merkle path. Both prepare and
     * execute call it so the submitted path is always derived from the latest tree — a keystore
     * insertion between the two changes the root, and a stale path reverts on-chain.
     *
     * @throws {CurrentLeafNotFound} If the caller's leaf is not in the current tree.
     */
    private async buildUpdateAuthPolicyCalldata(
        oldAuthDigest: Hex,
        newAuthDigest: Hex,
    ): Promise<TTx> {
        const nullifyingKeyHash = this.computeNullifyingKeyHash(
            this.keystoreManager.getPrivateNullifyingKey(),
        );
        const oldKeystoreLeaf = this.computeKeystoreLeaf(
            this.addressFieldConverter.toField(this.ownerAddress),
            nullifyingKeyHash,
            oldAuthDigest,
        );

        const leaves = await this.keystoreInteractor.getKeystoreLeaves();
        if (!leaves.includes(oldKeystoreLeaf)) {
            throw new CurrentLeafNotFound(oldKeystoreLeaf);
        }

        const merkleProof = await this.merkleService.generateMerkleProof(leaves, oldKeystoreLeaf);
        const siblings = this.merkleService.padSiblings(merkleProof.siblings, KEYSTORE_MAX_DEPTH);
        return this.keystoreInteractor.encodeUpdateAuthPolicy(
            oldAuthDigest,
            newAuthDigest,
            siblings,
        );
    }

    /** Computes the nullifying key hash: Poseidon(privateNullifyingKey). */
    private computeNullifyingKeyHash(privateNullifyingKey: Secret): Hex {
        return this.hashService.hash([privateNullifyingKey]);
    }

    /** Computes the keystore leaf: Poseidon(ownerAddress, nullifyingKeyHash, authDigest). */
    private computeKeystoreLeaf(
        ownerAddress: Address,
        nullifyingKeyHash: Hex,
        authDigest: Hex,
    ): Hex {
        return this.hashService.hash([ownerAddress, nullifyingKeyHash, authDigest]);
    }
}
