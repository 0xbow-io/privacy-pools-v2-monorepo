import type {
    Address,
    CircuitManifest,
    DeploymentAddresses,
    EncryptedStorageServiceConfig,
    IASPClient,
    IASPDataProvider,
    IASPRegistryInteractor,
    ICacheStore,
    ICircuitArtifacts,
    ICryptoService,
    IEntrypointInteractor,
    IGroth16Prover,
    IHashService,
    IHTTPClient,
    IKeystoreInteractor,
    IKeystoreManager,
    IMerkleService,
    INoteComputationService,
    INoteDiscoveryService,
    INoteManager,
    INoteStorageAdapter,
    IPaymentRequestService,
    IPaymentRequestStorageAdapter,
    IPoolVaultInteractor,
    IProofService,
    IRelayerInteractor,
    IRPCInteractor,
    IStorageService,
    ISwapAndDepositQuoteProvider,
    ISwapQuoteProvider,
    IWalletInteractor,
    IWitnessPreparationService,
    PersistentStorageConfig,
    PoolSession,
    PoolSessionBuilderConfig,
    PoolSessionSimpleConfig,
    RelayerChainDetails,
    RelayerInfo,
    SwapDepositSourceChainConfig,
    SwapExecutorAddresses,
    WalletInteractorConfig,
    YieldDeployment,
    YieldDepositTarget,
} from "../../internal.js";
import {
    AddressSchema,
    ASPClient,
    ASPRegistryInteractor,
    createEvmEntrypointInteractor,
    createEvmKeystoreInteractor,
    createEvmPoolVaultInteractor,
    CryptoService,
    DEFAULT_IPFS_GATEWAY_URLS,
    DEPLOYMENTS,
    EIP1193WalletInteractor,
    EncryptedStorageService,
    EvmSwapChainAdapter,
    FileStorageService,
    Groth16Prover,
    HttpASPDataProvider,
    HTTPClient,
    InMemoryStorageService,
    InvalidBuilderConfig,
    IpfsASPDataProvider,
    IpfsCircuitArtifacts,
    KeystoreManager,
    LocalCircuitArtifacts,
    LocalStorageService,
    createEvmPoolSession,
    MerkleService,
    NoteComputationService,
    NoteManager,
    NoteStorageAdapter,
    PaymentRequestService,
    PaymentRequestStorageAdapter,
    PoolSessionBuilderConfigSchema,
    PoseidonHashService,
    ProofService,
    RelayerInteractor,
    UnsupportedChainId,
    ViemRPCInteractor,
    ViemWalletInteractor,
    WitnessPreparationService,
} from "../../internal.js";
import {
    relaySwapsAddressFromDetails,
    yieldDeploymentsFromDetails,
} from "../../utils/RelayerDetails.js";

/** Returns true when at least one circuit pins a non-empty CID. CID well-formedness is enforced
 * upstream by {@link PoolSessionBuilderConfigSchema}, so a non-empty value here is always valid;
 * this only answers "is anything pinned at all?" to choose the IPFS vs local-artifacts path. */
function manifestHasPinnedCIDs(manifest: CircuitManifest): boolean {
    for (const cids of Object.values(manifest)) {
        if (cids.wasm !== "" || cids.provingKey !== "" || cids.verificationKey !== "") {
            return true;
        }
    }
    return false;
}

/** Overrides holder — one slot per injectable SDK dependency. */
const isZeroAddress = (a: string): boolean => /^0x0{40}$/i.test(a);

interface PoolSessionBuilderOverrides {
    cryptoService?: ICryptoService;
    hashService?: IHashService;
    merkleService?: IMerkleService;
    httpClient?: IHTTPClient;
    rpcInteractor?: IRPCInteractor;
    entrypointInteractor?: IEntrypointInteractor;
    keystoreInteractor?: IKeystoreInteractor;
    vaultInteractor?: IPoolVaultInteractor;
    aspRegistryInteractor?: IASPRegistryInteractor;
    aspDataProvider?: IASPDataProvider;
    aspClient?: IASPClient;
    relayerInteractor?: IRelayerInteractor;
    circuitArtifacts?: ICircuitArtifacts;
    circuitCacheStore?: ICacheStore;
    groth16Prover?: IGroth16Prover;
    proofService?: IProofService;
    witnessPreparationService?: IWitnessPreparationService;
    noteComputationService?: INoteComputationService;
    noteManager?: INoteManager;
    keystoreManager?: IKeystoreManager;
    storageService?: IStorageService;
    noteStorageAdapter?: INoteStorageAdapter;
    paymentRequestStorageAdapter?: IPaymentRequestStorageAdapter;
    noteDiscoveryService?: INoteDiscoveryService;
    paymentRequestService?: IPaymentRequestService;
    walletInteractor?: IWalletInteractor;
    swapQuoteProvider?: ISwapQuoteProvider;
    swapAndDepositQuoteProvider?: ISwapAndDepositQuoteProvider;
    swapExecutor?: SwapExecutorAddresses;
    destinationEntrypointInteractor?: IEntrypointInteractor;
    yieldDeployment?: YieldDeployment;
    yieldDeployments?: YieldDeployment[];
    destinationYieldDepositTargets?: YieldDepositTarget[];
    relaySwapsAddress?: Address;
    relayerChainDetails?: RelayerChainDetails[];
}

/**
 * Branded string type used in `this`-parameter conflict checks. When the
 * corresponding field is present in the stored config, the override method's
 * `this` type resolves to this brand and TS rejects the call with the
 * embedded message surfaced in the error.
 */
type ConflictError<Msg extends string> = Msg;

/**
 * Fluent builder for {@link PoolSession} initialization.
 *
 * Two entry points:
 *
 * - **Simple** — `await PoolSessionBuilder.create(config)` constructs a fully
 *   wired session with default implementations for every dependency. This is
 *   sugar for `PoolSessionBuilder.fromConfig(config).create()`.
 * - **Advanced** — `PoolSessionBuilder.fromConfig(config).withX(instance).create()`
 *   seeds the builder with atomic config then injects pre-built dependencies
 *   (custom crypto, hardware signing, test mocks). `.withX()` methods whose
 *   config sibling is already present in `config` are type errors at the call
 *   site — config comes first, overrides follow.
 *
 * Contract addresses default to `DEPLOYMENTS[config.chainId]`. Consumers on
 * chains not yet in the canonical manifest can supply `config.deployment`
 * explicitly, or override individual contract interactors via `.withX()`.
 * The two strategies are mutually exclusive: presence of `deployment` in
 * config disables the 4 contract-interactor `.withX()` methods at the type
 * level.
 *
 * **Escape hatch.** The builder is a convenience wrapper; it is *not* required.
 * Consumers needing finer control (partial sessions, custom service graphs,
 * isolated sub-session usage) should bypass it and call
 * {@link createEvmPoolSession} directly with a hand-assembled
 * `PoolSessionConfig`. It already tolerates missing
 * `poolVaultInteractor` / `aspClient` / `rpcInteractor` and omits the
 * corresponding sub-sessions from the returned `PoolSession`.
 */
export class PoolSessionBuilder<Cfg extends PoolSessionBuilderConfig = PoolSessionBuilderConfig> {
    /**
     * One-call constructor. Equivalent to `PoolSessionBuilder.fromConfig(config).create()`,
     * but accepts a narrowed {@link PoolSessionSimpleConfig} that enforces — at
     * the type level — every field the simple path cannot otherwise resolve
     * through a `.withX()` override (required `protocolKeys` / `relayers` /
     * `circuitArtifactsDir`, and XOR between `aspUrl` / `ipfsGatewayUrl`).
     *
     * @param config - Simple-path configuration for the session.
     * @returns A fully initialized PoolSession.
     * @throws {InvalidBuilderConfig} When the config fails structural validation or cross-field constraints.
     * @throws {UnsupportedChainId} When `config.deployment` is omitted and `config.chainId` has no entry in `DEPLOYMENTS`.
     */
    static async create(config: PoolSessionSimpleConfig): Promise<PoolSession> {
        return PoolSessionBuilder.fromConfig(config).create();
    }

    /**
     * Seeds a builder with an atomic config. Call `.withX()` for overrides
     * and terminate with `.create()`.
     *
     * @param config - Full session configuration.
     */
    static fromConfig<Cfg extends PoolSessionBuilderConfig>(config: Cfg): PoolSessionBuilder<Cfg> {
        return new PoolSessionBuilder<Cfg>(config);
    }

    // ECMAScript #private, not TS `private`: TS `private` is compile-time only, so the fields stay
    // enumerable at runtime and a retained builder (the `fromConfig().create()` path returns one)
    // would leak `protocolKeys` via JSON.stringify / Object.keys / spread / structured clone / a
    // crash-reporter dump. `#` excludes them from all of those. `#config` is cleared on successful
    // create() so the builder drops its reference to the keys (they still live in the session's
    // KeystoreManager — unavoidable); a consequence is the builder is single-use.
    #config: Cfg | undefined;
    readonly #overrides: PoolSessionBuilderOverrides = {};
    #sharedStorageService?: IStorageService;

    private constructor(config: Cfg) {
        this.#config = config;
    }

    /**
     * Assembles every SDK service (using overrides where provided and defaults
     * otherwise) and returns a fully wired {@link PoolSession}.
     *
     * @returns A fully initialized PoolSession.
     * @throws {InvalidBuilderConfig} When the config fails structural validation or cross-field constraints.
     * @throws {UnsupportedChainId} When `config.deployment` is omitted and `config.chainId` has no entry in `DEPLOYMENTS`.
     */
    async create(): Promise<PoolSession> {
        const config = this.#config;
        if (config === undefined) {
            throw new InvalidBuilderConfig(
                "This builder was already consumed by create(); construct a new one.",
            );
        }
        const parsed = PoolSessionBuilderConfigSchema.safeParse(config);
        if (!parsed.success) {
            const issue = parsed.error.issues[0]!;
            const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
            throw new InvalidBuilderConfig(`${at}${issue.message}`);
        }

        this.assertNoConflictingOverrides(config);

        const deployment = this.resolveDeployment(config);

        const logger = config.logger;
        const overrides = this.#overrides;

        const cryptoService = overrides.cryptoService ?? new CryptoService();
        const httpClient =
            overrides.httpClient ?? new HTTPClient(config.httpClientConfig, { logger });
        const hashService = overrides.hashService ?? (await PoseidonHashService.create());

        const rpcInteractor =
            overrides.rpcInteractor ??
            ViemRPCInteractor.create({ rpcUrl: config.rpcUrl }, { logger });

        const walletInteractor = this.resolveWalletInteractor(config);
        if (walletInteractor) {
            await this.assertWalletMatchesSession(walletInteractor, config);
        }

        const entrypointInteractor =
            overrides.entrypointInteractor ??
            createEvmEntrypointInteractor(
                {
                    rpcInteractor,
                    contractAddress: deployment.entrypointAddress,
                },
                {
                    walletInteractor,
                },
            );
        const deploymentBlock = config.deploymentBlock ? BigInt(config.deploymentBlock) : undefined;

        // Source-chain bundle for cross-chain swap-and-deposit: its own wallet and RPC,
        // since the input token and the LiFi transaction live on a different chain than
        // the pool. Validated below like the pool-chain wallet (account + chain match).
        let swapDepositSourceChain: SwapDepositSourceChainConfig | undefined;
        if (config.sourceChain !== undefined) {
            if (config.sourceChain.chainId === config.chainId) {
                throw new InvalidBuilderConfig(
                    `sourceChain.chainId ${config.sourceChain.chainId} equals the pool chainId — ` +
                        `omit sourceChain for same-chain swap-and-deposit`,
                );
            }
            const sourceWallet = this.buildWalletInteractor(
                config.sourceChain.walletInteractor,
                config.sourceChain.chainId,
            );
            await this.assertWalletMatchesAccountAndChain(
                sourceWallet,
                config.ownerAddress,
                config.sourceChain.chainId,
            );
            const sourceRpcInteractor = ViemRPCInteractor.create(
                { rpcUrl: config.sourceChain.rpcUrl },
                { logger },
            );
            swapDepositSourceChain = {
                chainId: config.sourceChain.chainId,
                walletInteractor: sourceWallet,
                rpcInteractor: sourceRpcInteractor,
                relaySwapsAddress: config.sourceChain.relaySwapsAddress,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: sourceRpcInteractor }),
            };
        }

        // Destination-chain Entrypoint for PoolSessionReshieldCrosschain — its own RPC
        // connection, since it targets a different chain than `rpcInteractor` above.
        // Absent entirely (and reshieldCrosschain unavailable) unless destinationChainId
        // is supplied — see PoolSessionFactory for the availability gate.
        let destinationEntrypointInteractor: IEntrypointInteractor | undefined;
        if (config.destinationChainId !== undefined) {
            const destinationDeployment =
                overrides.destinationEntrypointInteractor === undefined
                    ? this.resolveDestinationDeployment(config)
                    : undefined;
            const destinationRpcInteractor = ViemRPCInteractor.create(
                { rpcUrl: config.destinationRpcUrl! },
                { logger },
            );
            destinationEntrypointInteractor =
                overrides.destinationEntrypointInteractor ??
                createEvmEntrypointInteractor(
                    {
                        rpcInteractor: destinationRpcInteractor,
                        contractAddress: destinationDeployment!.entrypointAddress,
                    },
                    { walletInteractor },
                );
        }

        const keystoreInteractor =
            overrides.keystoreInteractor ??
            createEvmKeystoreInteractor(
                {
                    rpcInteractor,
                    contractAddress: deployment.keystoreAddress,
                    deploymentBlock,
                },
                { walletInteractor, seed: config.keystoreLeafCacheSeed },
            );
        // Fire-and-forget warm-up: any transact/withdraw/reshield/ragequit flow
        // eventually needs a full keystore leaf scan (TransactOrchestrator.
        // fetchMerkleLeaves / PoolSessionRagequit), and that scan can take many
        // seconds on a cold KeystoreInteractor — long enough, in practice, to
        // blow through a relayer's short-lived signed fee commitment if it only
        // starts once proof-building begins. Kicking it off here instead lets it
        // run concurrently with whatever the caller does next (deposit proof
        // generation, LiFi quote fetching, etc.) so the cache
        // (KeystoreInteractor.getKeystoreLeaves's cachedLeaves/cachedToBlock) is
        // already warm — or has less delta left to fetch — by the time a real
        // call needs it. Errors are swallowed here on purpose: this is a
        // best-effort warm-up, not a real request: a genuine failure (bad RPC,
        // wrong address) surfaces properly on the real call later.
        void keystoreInteractor.getKeystoreLeaves().catch(() => {
            /* swallowed on purpose — see comment above */
        });
        const poolVaultInteractor =
            overrides.vaultInteractor ??
            createEvmPoolVaultInteractor(
                { rpcInteractor, contractAddress: deployment.poolAddress, deploymentBlock },
                { logger, walletInteractor, seed: config.stateLeafCacheSeed },
            );
        // Fire-and-forget warm-up for the state-tree leaf scan, same rationale
        // as the keystore warm-up above: PoolVaultInteractor.getStateLeaves()
        // is the sibling scan in TransactOrchestrator.fetchMerkleLeaves's
        // Promise.all, and either scan can independently be the slow one
        // depending on which contract has deeper history.
        void poolVaultInteractor.getStateLeaves().catch(() => {
            /* swallowed on purpose — see comment above */
        });
        const aspRegistryInteractor =
            overrides.aspRegistryInteractor ??
            new ASPRegistryInteractor({
                rpcInteractor,
                contractAddress: deployment.aspRegistryAddress,
            });

        const merkleService =
            overrides.merkleService ?? new MerkleService({ hashService }, { logger });
        const noteComputationService =
            overrides.noteComputationService ??
            new NoteComputationService({ hashService, cryptoService }, { logger });

        const aspDataProvider = this.resolveAspDataProvider(config, {
            httpClient,
            aspRegistryInteractor,
            entrypointAddress: deployment.entrypointAddress,
            logger,
        });

        const aspClient =
            overrides.aspClient ??
            new ASPClient(
                {
                    providers: [aspDataProvider],
                    merkleService,
                    aspRegistryInteractor,
                    publicKey: config.aspPublicKey,
                },
                { logger },
            );

        const circuitArtifacts = this.resolveCircuitArtifacts(config, { httpClient, logger });
        const groth16Prover = overrides.groth16Prover ?? new Groth16Prover();
        const proofService =
            overrides.proofService ??
            new ProofService({ circuitArtifacts, groth16Prover }, { logger });
        const witnessPreparationService =
            overrides.witnessPreparationService ??
            new WitnessPreparationService(
                { noteComputationService, hashService, merkleService },
                { logger },
            );

        const keystoreManager = this.resolveKeystoreManager(config);
        const storageAdapter = this.resolveNoteStorageAdapter(config);
        const paymentRequestStorageAdapter = this.resolvePaymentRequestStorageAdapter(config);
        const noteManager =
            overrides.noteManager ?? new NoteManager({}, { logger, storageAdapter });

        const paymentRequestService =
            overrides.paymentRequestService ??
            new PaymentRequestService(
                {
                    ownerAddress: config.ownerAddress,
                    cryptoService,
                    hashService,
                    noteComputationService,
                    keystoreManager,
                    storageAdapter:
                        paymentRequestStorageAdapter ??
                        new PaymentRequestStorageAdapter(
                            config.chainId,
                            new InMemoryStorageService(),
                            config.ownerAddress,
                        ),
                },
                { logger },
            );

        if (storageAdapter) {
            await noteManager.loadFromStorage();
        }
        if (paymentRequestStorageAdapter) {
            await paymentRequestService.loadFromStorage();
        }

        const relayerInteractor = this.resolveRelayerInteractor(config, httpClient);

        const session = createEvmPoolSession(
            {
                ownerAddress: config.ownerAddress,
                chainId: config.chainId,
                cryptoService,
                witnessPreparationService,
                proofService,
                entrypointInteractor,
                noteManager,
                keystoreManager,
                keystoreInteractor,
                hashService,
                merkleService,
                poolVaultInteractor,
                aspClient,
                relayerInteractor,
                rpcInteractor,
                aspDataProvider,
                noteComputationService,
                noteDiscoveryService: overrides.noteDiscoveryService,
                paymentRequestService,
                swapQuoteProvider: overrides.swapQuoteProvider,
                swapAndDepositQuoteProvider: overrides.swapAndDepositQuoteProvider,
                swapExecutor: overrides.swapExecutor,
                // Order: deployment config pins RelaySwaps when set; otherwise the relayer's own
                // /details answer (withRelayerDetails). Never a hand-copied default.
                relaySwapsAddress:
                    deployment.relaySwapsAddress && !isZeroAddress(deployment.relaySwapsAddress)
                        ? deployment.relaySwapsAddress
                        : (overrides.relaySwapsAddress ?? deployment.relaySwapsAddress),
                yieldDeployment: overrides.yieldDeployment,
                yieldDeployments: overrides.yieldDeployments,
                destinationYieldDepositTargets: overrides.destinationYieldDepositTargets,
                relayerChainDetails: overrides.relayerChainDetails,
                swapDepositSourceChain,
                destinationChainId: config.destinationChainId,
                destinationEntrypointInteractor,
            },
            { logger },
        );

        // Session is wired; drop the builder's reference to the caller config (incl. protocolKeys).
        this.#config = undefined;
        return session;
    }

    withCryptoService(cryptoService: ICryptoService): this {
        this.#overrides.cryptoService = cryptoService;
        return this;
    }

    /**
     * Enables the Aave-yield namespace (`session.yield`) and makes the withdraw-and-swap session
     * quote this wrapper's shares on their underlying (RelaySwaps unwrap path).
     */
    withYieldDeployment(yieldDeployment: YieldDeployment): this {
        this.#overrides.yieldDeployment = yieldDeployment;
        return this;
    }

    /** Enables one yield namespace per deployment (`session.yieldFor(...)`); see `PoolSessionConfig.yieldDeployments`. */
    withYieldDeployments(yieldDeployments: YieldDeployment[]): this {
        this.#overrides.yieldDeployments = yieldDeployments;
        return this;
    }

    /** Use the destination session's yields (`destinationSession.yields`) for cross-chain share deposits and sizing. */
    withDestinationYieldDepositTargets(targets: YieldDepositTarget[]): this {
        this.#overrides.destinationYieldDepositTargets = targets;
        return this;
    }

    /**
     * Derives every relayer-side address from the relayer's own `/v1/details` answer
     * (`IRelayerInteractor.getChainDetails`) instead of hand-copied config: the RelaySwaps
     * address (unless the deployment already pins one) and one yield deployment per published
     * wrapper, whose `router` is the processor yield withdrawals bind into their proof. A
     * wrong processor fails every relay of that note with `PoolVault_ProofContextMismatch`
     * (minr #30). Explicit `withYieldDeployment(s)` calls still win. The details are also kept
     * (one entry per call) to seed the cross-chain reshield's relayer-cap check, so it does not
     * re-fetch `/v1/details` for a relayer the caller already asked.
     */
    withRelayerDetails(details: RelayerChainDetails): this {
        this.#overrides.relayerChainDetails = [...(this.#overrides.relayerChainDetails ?? []), details];
        const relaySwapsAddress = relaySwapsAddressFromDetails(details);
        if (relaySwapsAddress && !this.#overrides.relaySwapsAddress) {
            this.#overrides.relaySwapsAddress = relaySwapsAddress;
        }
        if (!this.#overrides.yieldDeployments && !this.#overrides.yieldDeployment) {
            const derived = yieldDeploymentsFromDetails(details);
            if (derived.length > 0) this.#overrides.yieldDeployments = derived;
        }
        return this;
    }

    withSwapQuoteProvider(swapQuoteProvider: ISwapQuoteProvider): this {
        this.#overrides.swapQuoteProvider = swapQuoteProvider;
        return this;
    }

    withSwapAndDepositQuoteProvider(
        swapAndDepositQuoteProvider: ISwapAndDepositQuoteProvider,
    ): this {
        this.#overrides.swapAndDepositQuoteProvider = swapAndDepositQuoteProvider;
        return this;
    }

    /**
     * Sets the swap executor the same-chain swap-and-deposit and reshield sessions compose their
     * executor transactions through, in place of `LIFI_SWAP_EXECUTORS[chainId]` (which lists only the chains LiFi's Executor is
     * deployed on). It must answer `erc20Proxy()` like LiFi's Executor, and both addresses must be
     * on the RelaySwaps router allowlist.
     */
    withSwapExecutor(swapExecutor: SwapExecutorAddresses): this {
        this.#overrides.swapExecutor = swapExecutor;
        return this;
    }

    withHashService(hashService: IHashService): this {
        this.#overrides.hashService = hashService;
        return this;
    }

    withMerkleService(merkleService: IMerkleService): this {
        this.#overrides.merkleService = merkleService;
        return this;
    }

    withHttpClient(httpClient: IHTTPClient): this {
        this.#overrides.httpClient = httpClient;
        return this;
    }

    withRpcInteractor(rpcInteractor: IRPCInteractor): this {
        this.#overrides.rpcInteractor = rpcInteractor;
        return this;
    }

    withEntrypointInteractor(
        this: Cfg extends { deployment: DeploymentAddresses }
            ? ConflictError<"ERROR: remove `deployment` from config before calling .with*Interactor() (interactor overrides and explicit `deployment` are mutually exclusive — rely on DEPLOYMENTS[chainId] for the non-overridden addresses)">
            : PoolSessionBuilder<Cfg>,
        entrypointInteractor: IEntrypointInteractor,
    ): PoolSessionBuilder<Cfg> {
        const self = this as unknown as PoolSessionBuilder<Cfg>;
        self.#overrides.entrypointInteractor = entrypointInteractor;
        return self;
    }

    /**
     * Overrides the destination-chain Entrypoint interactor used by
     * `PoolSessionReshieldCrosschain`. Requires `destinationChainId` in
     * config; conflicts with `destinationDeployment` (runtime-checked —
     * unlike the primary chain's `.with*Interactor()` overrides, this one
     * does not use the compile-time `this`-parameter conflict brand).
     */
    withDestinationEntrypointInteractor(
        destinationEntrypointInteractor: IEntrypointInteractor,
    ): this {
        this.#overrides.destinationEntrypointInteractor = destinationEntrypointInteractor;
        return this;
    }

    withKeystoreInteractor(
        this: Cfg extends { deployment: DeploymentAddresses }
            ? ConflictError<"ERROR: remove `deployment` from config before calling .with*Interactor() (interactor overrides and explicit `deployment` are mutually exclusive — rely on DEPLOYMENTS[chainId] for the non-overridden addresses)">
            : PoolSessionBuilder<Cfg>,
        keystoreInteractor: IKeystoreInteractor,
    ): PoolSessionBuilder<Cfg> {
        const self = this as PoolSessionBuilder<Cfg>;
        self.#overrides.keystoreInteractor = keystoreInteractor;
        return self;
    }

    withVaultInteractor(
        this: Cfg extends { deployment: DeploymentAddresses }
            ? ConflictError<"ERROR: remove `deployment` from config before calling .with*Interactor() (interactor overrides and explicit `deployment` are mutually exclusive — rely on DEPLOYMENTS[chainId] for the non-overridden addresses)">
            : PoolSessionBuilder<Cfg>,
        vaultInteractor: IPoolVaultInteractor,
    ): PoolSessionBuilder<Cfg> {
        const self = this as PoolSessionBuilder<Cfg>;
        self.#overrides.vaultInteractor = vaultInteractor;
        return self;
    }

    withAspRegistryInteractor(
        this: Cfg extends { deployment: DeploymentAddresses }
            ? ConflictError<"ERROR: remove `deployment` from config before calling .with*Interactor() (interactor overrides and explicit `deployment` are mutually exclusive — rely on DEPLOYMENTS[chainId] for the non-overridden addresses)">
            : PoolSessionBuilder<Cfg>,
        aspRegistryInteractor: IASPRegistryInteractor,
    ): PoolSessionBuilder<Cfg> {
        const self = this as PoolSessionBuilder<Cfg>;
        self.#overrides.aspRegistryInteractor = aspRegistryInteractor;
        return self;
    }

    withAspDataProvider(
        this: Cfg extends { aspUrl: string } | { ipfsGatewayUrl: string }
            ? ConflictError<"ERROR: remove `aspUrl`/`ipfsGatewayUrl` from config before calling .withAspDataProvider()">
            : PoolSessionBuilder<Cfg>,
        aspDataProvider: IASPDataProvider,
    ): PoolSessionBuilder<Cfg> {
        const self = this as PoolSessionBuilder<Cfg>;
        self.#overrides.aspDataProvider = aspDataProvider;
        return self;
    }

    withAspClient(
        this: Cfg extends { aspPublicKey: string }
            ? ConflictError<"ERROR: remove `aspPublicKey` from config before calling .withAspClient() (the provided client owns its own public key)">
            : PoolSessionBuilder<Cfg>,
        aspClient: IASPClient,
    ): PoolSessionBuilder<Cfg> {
        const self = this as PoolSessionBuilder<Cfg>;
        self.#overrides.aspClient = aspClient;
        return self;
    }

    withRelayerInteractor(
        this: Cfg extends { relayers: RelayerInfo[] }
            ? ConflictError<"ERROR: remove `relayers` from config before calling .withRelayerInteractor()">
            : PoolSessionBuilder<Cfg>,
        relayerInteractor: IRelayerInteractor,
    ): PoolSessionBuilder<Cfg> {
        const self = this as PoolSessionBuilder<Cfg>;
        self.#overrides.relayerInteractor = relayerInteractor;
        return self;
    }

    withCircuitArtifacts(
        this: Cfg extends { circuitArtifactsDir: string } | { circuitGatewayUrls: string[] }
            ? ConflictError<"ERROR: remove `circuitArtifactsDir`/`circuitGatewayUrls` from config before calling .withCircuitArtifacts()">
            : PoolSessionBuilder<Cfg>,
        circuitArtifacts: ICircuitArtifacts,
    ): PoolSessionBuilder<Cfg> {
        const self = this as PoolSessionBuilder<Cfg>;
        self.#overrides.circuitArtifacts = circuitArtifacts;
        return self;
    }

    withCircuitCacheStore(cacheStore: ICacheStore): this {
        this.#overrides.circuitCacheStore = cacheStore;
        return this;
    }

    withGroth16Prover(groth16Prover: IGroth16Prover): this {
        this.#overrides.groth16Prover = groth16Prover;
        return this;
    }

    withProofService(proofService: IProofService): this {
        this.#overrides.proofService = proofService;
        return this;
    }

    withWitnessPreparationService(witnessPreparationService: IWitnessPreparationService): this {
        this.#overrides.witnessPreparationService = witnessPreparationService;
        return this;
    }

    withNoteComputationService(noteComputationService: INoteComputationService): this {
        this.#overrides.noteComputationService = noteComputationService;
        return this;
    }

    withNoteManager(noteManager: INoteManager): this {
        this.#overrides.noteManager = noteManager;
        return this;
    }

    withKeystoreManager(
        this: Cfg extends { protocolKeys: object }
            ? ConflictError<"ERROR: remove `protocolKeys` from config before calling .withKeystoreManager()">
            : PoolSessionBuilder<Cfg>,
        keystoreManager: IKeystoreManager,
    ): PoolSessionBuilder<Cfg> {
        const self = this as PoolSessionBuilder<Cfg>;
        self.#overrides.keystoreManager = keystoreManager;
        return self;
    }

    withStorageService(
        this: Cfg extends { persistentStorage: PersistentStorageConfig }
            ? ConflictError<"ERROR: remove `persistentStorage` from config before calling .withStorageService() (declarative storage and explicit IStorageService override are mutually exclusive)">
            : PoolSessionBuilder<Cfg>,
        storageService: IStorageService,
    ): PoolSessionBuilder<Cfg> {
        const self = this as PoolSessionBuilder<Cfg>;
        self.#overrides.storageService = storageService;
        return self;
    }

    /**
     * Opt-in AEAD-sealed at-rest storage (RC-03 #281/#360). Convenience sugar for
     * `.withStorageService(new EncryptedStorageService(config))`: wraps the given
     * `inner` store so every persisted value is XChaCha20-Poly1305-encrypted under
     * a key derived from `config.passphrase` via scrypt. The passphrase is never
     * persisted. Mutually exclusive with declarative `persistentStorage` config
     * (that path builds an unencrypted store) — the sealed store is entirely opt-in
     * and never the default.
     *
     * @param config - Encrypted-storage configuration (`inner`, `passphrase`, optional `kdfParams`).
     */
    withEncryptedStorage(
        this: Cfg extends { persistentStorage: PersistentStorageConfig }
            ? ConflictError<"ERROR: remove `persistentStorage` from config before calling .withEncryptedStorage() (declarative storage and explicit encrypted storage are mutually exclusive)">
            : PoolSessionBuilder<Cfg>,
        config: EncryptedStorageServiceConfig,
    ): PoolSessionBuilder<Cfg> {
        const self = this as PoolSessionBuilder<Cfg>;
        self.#overrides.storageService = new EncryptedStorageService(config);
        return self;
    }

    withWalletInteractor(
        this: Cfg extends { walletInteractor: WalletInteractorConfig }
            ? ConflictError<"ERROR: remove `walletInteractor` from config before calling .withWalletInteractor() (declarative wallet interactor and explicit IWalletInteractor override are mutually exclusive)">
            : PoolSessionBuilder<Cfg>,
        walletInteractor: IWalletInteractor,
    ): PoolSessionBuilder<Cfg> {
        const self = this as PoolSessionBuilder<Cfg>;
        self.#overrides.walletInteractor = walletInteractor;
        return self;
    }

    withNoteStorageAdapter(
        this: Cfg extends { persistentStorage: PersistentStorageConfig }
            ? ConflictError<"ERROR: remove `persistentStorage` from config before calling .withNoteStorageAdapter() (declarative storage and explicit INoteStorageAdapter override are mutually exclusive)">
            : PoolSessionBuilder<Cfg>,
        noteStorageAdapter: INoteStorageAdapter,
    ): PoolSessionBuilder<Cfg> {
        const self = this as PoolSessionBuilder<Cfg>;
        self.#overrides.noteStorageAdapter = noteStorageAdapter;
        return self;
    }

    withPaymentRequestStorageAdapter(
        this: Cfg extends { persistentStorage: PersistentStorageConfig }
            ? ConflictError<"ERROR: remove `persistentStorage` from config before calling .withPaymentRequestStorageAdapter() (declarative storage and explicit IPaymentRequestStorageAdapter override are mutually exclusive)">
            : PoolSessionBuilder<Cfg>,
        paymentRequestStorageAdapter: IPaymentRequestStorageAdapter,
    ): PoolSessionBuilder<Cfg> {
        const self = this as PoolSessionBuilder<Cfg>;
        self.#overrides.paymentRequestStorageAdapter = paymentRequestStorageAdapter;
        return self;
    }

    withNoteDiscoveryService(noteDiscoveryService: INoteDiscoveryService): this {
        this.#overrides.noteDiscoveryService = noteDiscoveryService;
        return this;
    }

    withPaymentRequestService(paymentRequestService: IPaymentRequestService): this {
        this.#overrides.paymentRequestService = paymentRequestService;
        return this;
    }

    private assertNoConflictingOverrides(config: PoolSessionBuilderConfig): void {
        const overrides = this.#overrides;
        const interactorOverridden =
            overrides.entrypointInteractor !== undefined ||
            overrides.keystoreInteractor !== undefined ||
            overrides.vaultInteractor !== undefined ||
            overrides.aspRegistryInteractor !== undefined;

        const conflicts: [boolean, string][] = [
            [
                config.protocolKeys !== undefined && overrides.keystoreManager !== undefined,
                "`protocolKeys` and a `KeystoreManager` override",
            ],
            [
                config.relayers !== undefined && overrides.relayerInteractor !== undefined,
                "`relayers` and a `RelayerInteractor` override",
            ],
            [
                config.circuitArtifactsDir !== undefined &&
                    overrides.circuitArtifacts !== undefined,
                "`circuitArtifactsDir` and a `CircuitArtifacts` override",
            ],
            [
                config.circuitGatewayUrls !== undefined && overrides.circuitArtifacts !== undefined,
                "`circuitGatewayUrls` and a `CircuitArtifacts` override",
            ],
            [
                overrides.circuitCacheStore !== undefined &&
                    (overrides.circuitArtifacts !== undefined ||
                        config.circuitArtifactsDir !== undefined),
                "a `CircuitCacheStore` override and a local circuit path (cache store applies only to the IPFS circuit path)",
            ],
            [
                (config.aspUrl !== undefined || config.ipfsGatewayUrl !== undefined) &&
                    overrides.aspDataProvider !== undefined,
                "`aspUrl`/`ipfsGatewayUrl` and an `AspDataProvider` override",
            ],
            [
                config.aspPublicKey !== undefined && overrides.aspClient !== undefined,
                "`aspPublicKey` and an `AspClient` override",
            ],
            [
                config.deployment !== undefined && interactorOverridden,
                "`deployment` and a contract-interactor override (`.with*Interactor()`)",
            ],
            [
                config.persistentStorage !== undefined && overrides.storageService !== undefined,
                "`persistentStorage` and a `StorageService` override",
            ],
            [
                config.persistentStorage !== undefined &&
                    overrides.noteStorageAdapter !== undefined,
                "`persistentStorage` and a `NoteStorageAdapter` override",
            ],
            [
                overrides.storageService !== undefined &&
                    overrides.noteStorageAdapter !== undefined,
                "a `StorageService` override and a `NoteStorageAdapter` override",
            ],
            [
                config.persistentStorage !== undefined &&
                    overrides.paymentRequestStorageAdapter !== undefined,
                "`persistentStorage` and a `PaymentRequestStorageAdapter` override",
            ],
            [
                overrides.storageService !== undefined &&
                    overrides.paymentRequestStorageAdapter !== undefined,
                "a `StorageService` override and a `PaymentRequestStorageAdapter` override",
            ],
            [
                overrides.paymentRequestService !== undefined &&
                    overrides.paymentRequestStorageAdapter !== undefined,
                "a `PaymentRequestService` override and a `PaymentRequestStorageAdapter` override (the service owns its own adapter)",
            ],
            [
                config.walletInteractor !== undefined && overrides.walletInteractor !== undefined,
                "a `WalletInteractor` overrides `walletInteractor`",
            ],
            [
                config.destinationDeployment !== undefined &&
                    overrides.destinationEntrypointInteractor !== undefined,
                "`destinationDeployment` and a `.withDestinationEntrypointInteractor()` override (rely on DEPLOYMENTS[destinationChainId] when overriding the interactor directly)",
            ],
            [
                overrides.destinationEntrypointInteractor !== undefined &&
                    config.destinationChainId === undefined,
                "a `.withDestinationEntrypointInteractor()` override without `destinationChainId` set in config",
            ],
        ];
        for (const [triggered, fields] of conflicts) {
            if (triggered) {
                throw new InvalidBuilderConfig(
                    `Supply either ${fields}, not both — remove one to avoid ambiguity`,
                );
            }
        }
    }

    private resolveDeployment(config: PoolSessionBuilderConfig): DeploymentAddresses {
        if (config.deployment) {
            return config.deployment;
        }
        const preset = DEPLOYMENTS[config.chainId];
        if (!preset) {
            throw new UnsupportedChainId(config.chainId);
        }
        return preset;
    }

    /** Mirrors {@link resolveDeployment} for `destinationChainId`. Only called when `destinationChainId` is set. */
    private resolveDestinationDeployment(config: PoolSessionBuilderConfig): DeploymentAddresses {
        if (config.destinationDeployment) {
            return config.destinationDeployment;
        }
        const preset = DEPLOYMENTS[config.destinationChainId!];
        if (!preset) {
            throw new UnsupportedChainId(config.destinationChainId!);
        }
        return preset;
    }

    private resolveAspDataProvider(
        config: PoolSessionBuilderConfig,
        deps: {
            httpClient: IHTTPClient;
            aspRegistryInteractor: IASPRegistryInteractor;
            entrypointAddress: Address;
            logger?: PoolSessionBuilderConfig["logger"];
        },
    ): IASPDataProvider {
        if (this.#overrides.aspDataProvider) {
            return this.#overrides.aspDataProvider;
        }

        if (config.ipfsGatewayUrl !== undefined) {
            return new IpfsASPDataProvider(
                {
                    ipfsGatewayUrl: config.ipfsGatewayUrl,
                    aspRegistryInteractor: deps.aspRegistryInteractor,
                    httpClient: deps.httpClient,
                },
                { logger: deps.logger },
            );
        }

        if (config.aspUrl === undefined) {
            throw new InvalidBuilderConfig(
                "aspUrl or ipfsGatewayUrl is required unless an AspDataProvider override is supplied",
            );
        }

        return new HttpASPDataProvider(
            {
                aspUrl: config.aspUrl,
                chainId: config.chainId,
                entrypointAddress: deps.entrypointAddress,
                httpClient: deps.httpClient,
            },
            { logger: deps.logger },
        );
    }

    private resolveCircuitArtifacts(
        config: PoolSessionBuilderConfig,
        deps: { httpClient: IHTTPClient; logger?: PoolSessionBuilderConfig["logger"] },
    ): ICircuitArtifacts {
        if (this.#overrides.circuitArtifacts) {
            return this.#overrides.circuitArtifacts;
        }
        if (config.circuitArtifactsDir !== undefined) {
            return new LocalCircuitArtifacts({ baseDir: config.circuitArtifactsDir });
        }
        // Audit M-11: never fall back to DEFAULT_CIRCUIT_MANIFEST silently.
        // A silent default makes the npm package version the trust root for
        // proving artifacts — a routine SDK update could rotate CIDs against
        // an unchanged on-chain verifier and break every proof flow. The
        // integrator must opt in explicitly so that coupling is visible.
        if (config.circuitManifest === undefined) {
            throw new InvalidBuilderConfig(
                "circuitManifest must be supplied explicitly. Pass `circuitArtifactsDir` " +
                    "(LocalCircuitArtifacts), an explicit `circuitManifest` with pinned CIDs " +
                    "(import DEFAULT_CIRCUIT_MANIFEST if you want the SDK-shipped one — but be " +
                    "aware that locks proof correctness to the SDK package version), or a " +
                    "`.withCircuitArtifacts()` override.",
            );
        }
        const circuitManifest = config.circuitManifest;

        // Empty-CID guard: surface explicit empty-pin manifests at construction
        // time rather than letting the user discover it via a runtime
        // "No CID pinned" error mid-flow.
        if (!manifestHasPinnedCIDs(circuitManifest)) {
            throw new InvalidBuilderConfig(
                "circuitManifest has no pinned CIDs (all entries are empty). " +
                    "Supply real pinned CIDs or use `circuitArtifactsDir` for local artifacts.",
            );
        }

        const ipfsGatewayUrls = this.resolveCircuitGatewayUrls(config);

        return new IpfsCircuitArtifacts(
            {
                ipfsGatewayUrls,
                circuitManifest,
                httpClient: deps.httpClient,
            },
            {
                cacheStore: this.#overrides.circuitCacheStore,
                logger: deps.logger,
            },
        );
    }

    private resolveCircuitGatewayUrls(config: PoolSessionBuilderConfig): string[] {
        return config.circuitGatewayUrls ?? [...DEFAULT_IPFS_GATEWAY_URLS];
    }

    private resolveKeystoreManager(config: PoolSessionBuilderConfig): IKeystoreManager {
        if (this.#overrides.keystoreManager) {
            return this.#overrides.keystoreManager;
        }
        if (config.protocolKeys === undefined) {
            throw new InvalidBuilderConfig(
                "protocolKeys is required unless a KeystoreManager override is supplied",
            );
        }
        return new KeystoreManager(config.protocolKeys);
    }

    private resolveRelayerInteractor(
        config: PoolSessionBuilderConfig,
        httpClient: IHTTPClient,
    ): IRelayerInteractor {
        if (this.#overrides.relayerInteractor) {
            return this.#overrides.relayerInteractor;
        }
        if (config.relayers === undefined || config.relayers.length === 0) {
            throw new InvalidBuilderConfig(
                "At least one relayer is required unless a RelayerInteractor override is supplied",
            );
        }
        return new RelayerInteractor(
            { relayers: config.relayers, httpClient, addressSchema: AddressSchema },
            { logger: config.logger },
        );
    }

    private resolveNoteStorageAdapter(
        config: PoolSessionBuilderConfig,
    ): INoteStorageAdapter | undefined {
        if (this.#overrides.noteStorageAdapter) {
            return this.#overrides.noteStorageAdapter;
        }
        const storage = this.resolveSharedStorageService(config);
        if (!storage) return undefined;
        return new NoteStorageAdapter(config.chainId, storage, config.ownerAddress);
    }

    private resolvePaymentRequestStorageAdapter(
        config: PoolSessionBuilderConfig,
    ): IPaymentRequestStorageAdapter | undefined {
        if (this.#overrides.paymentRequestStorageAdapter) {
            return this.#overrides.paymentRequestStorageAdapter;
        }
        const storage = this.resolveSharedStorageService(config);
        if (!storage) return undefined;
        return new PaymentRequestStorageAdapter(config.chainId, storage, config.ownerAddress);
    }

    /**
     * Returns a single `IStorageService` instance shared by every adapter in
     * this builder. Critical for file-backed persistence: two adapters
     * pointing at the same JSON file via independent `FileStorageService`
     * instances would race on the shared `.tmp` rename (lost updates, or
     * `ENOENT` poisoning one instance's write queue for the rest of the
     * process — sub-866 second half).
     */
    private resolveSharedStorageService(
        config: PoolSessionBuilderConfig,
    ): IStorageService | undefined {
        if (this.#overrides.storageService) return this.#overrides.storageService;
        if (this.#sharedStorageService) return this.#sharedStorageService;
        const built = this.buildStorageService(config.persistentStorage);
        this.#sharedStorageService = built;
        return built;
    }

    private buildStorageService(cfg?: PersistentStorageConfig): IStorageService | undefined {
        switch (cfg?.type) {
            case "file":
                return new FileStorageService({
                    dirPath: cfg.dirPath,
                    filename: cfg.filename ?? "privacy-pool-notes",
                });
            case "local":
                return new LocalStorageService({ prefix: cfg.prefix });
            case "memory":
                return new InMemoryStorageService();
        }
    }

    private resolveWalletInteractor(
        config: PoolSessionBuilderConfig,
    ): IWalletInteractor | undefined {
        if (this.#overrides.walletInteractor) {
            return this.#overrides.walletInteractor;
        }
        if (!config.walletInteractor) return undefined;

        return this.buildWalletInteractor(config.walletInteractor, config.chainId);
    }

    /**
     * Builds a wallet interactor bound to `expectedChainId`.
     *
     * The binding is what makes the chain check hold for the session's whole life:
     * `assertWalletMatchesAccountAndChain` runs once, at build, while the user's wallet can
     * switch networks at any point afterwards, and a prepared transaction names an address
     * and never a chain.
     */
    private buildWalletInteractor(
        cfg: WalletInteractorConfig,
        expectedChainId: number,
    ): IWalletInteractor {
        switch (cfg.type) {
            case "EIP1193":
                return new EIP1193WalletInteractor({ provider: cfg.provider, expectedChainId });
            case "viem":
                return new ViemWalletInteractor({
                    walletClient: cfg.walletClient,
                    expectedChainId,
                });
        }
    }

    /**
     * Verifies the wallet's active account + chain match the session config
     * before any state-changing write goes out.
     *
     * @throws {InvalidBuilderConfig} On account or chain mismatch.
     */
    private async assertWalletMatchesSession(
        walletInteractor: IWalletInteractor,
        config: PoolSessionBuilderConfig,
    ): Promise<void> {
        await this.assertWalletMatchesAccountAndChain(
            walletInteractor,
            config.ownerAddress,
            config.chainId,
        );
    }

    /**
     * Verifies a wallet's active account and chain match the expected pair — used for
     * both the pool-chain wallet and the cross-chain swap-deposit source wallet.
     *
     * @throws {InvalidBuilderConfig} On account or chain mismatch.
     */
    private async assertWalletMatchesAccountAndChain(
        walletInteractor: IWalletInteractor,
        ownerAddress: Address,
        expectedChainId: number,
    ): Promise<void> {
        const accounts = await walletInteractor.getAccounts();
        const activeAccount = accounts[0];
        if (!activeAccount) {
            throw new InvalidBuilderConfig("Wallet returned no accounts");
        }
        if (activeAccount.toLowerCase() !== ownerAddress.toLowerCase()) {
            throw new InvalidBuilderConfig(
                `Wallet account ${activeAccount} does not match session ownerAddress ${ownerAddress}`,
            );
        }
        const walletChainId = await walletInteractor.getChainId();
        if (walletChainId !== expectedChainId) {
            throw new InvalidBuilderConfig(
                `Wallet chain ${walletChainId} does not match expected chainId ${expectedChainId}`,
            );
        }
    }
}
