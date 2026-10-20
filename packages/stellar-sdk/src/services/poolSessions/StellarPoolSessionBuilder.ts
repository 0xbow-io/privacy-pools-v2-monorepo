import { Keypair } from "@stellar/stellar-sdk";

import type {
    Address,
    IASPDataProvider,
    ICircuitArtifacts,
    ICryptoService,
    IHTTPClient,
    IKeystoreManager,
    INoteManager,
    IPaymentRequestService,
    IRelayerInteractor,
    IStellarWalletInteractor,
    IStorageService,
    PersistentStorageConfig,
    StellarPoolSession,
    StellarAddress,
    StellarDeriveFromSignatureConfig,
    StellarLog,
    StellarPoolSessionBuilderConfig,
    StellarProof,
    StellarWalletInteractorConfig,
} from "../../internal.js";
import {
    ASPClient,
    createFreighterProvider,
    createStellarEntrypointInteractor,
    createStellarKeystoreInteractor,
    createStellarPoolSession,
    createStellarPoolVaultInteractor,
    FileStorageService,
    FreighterWalletInteractor,
    Groth16Prover,
    HTTPClient,
    InMemoryStorageService,
    InvalidBuilderConfig,
    IpfsASPDataProvider,
    IpfsCircuitArtifacts,
    KeypairWalletInteractor,
    KeystoreManager,
    LocalCircuitArtifacts,
    LocalStorageService,
    MerkleService,
    NoteComputationService,
    NoteManager,
    NoteStorageAdapter,
    PaymentRequestService,
    PaymentRequestStorageAdapter,
    PoseidonHashService,
    SorobanRPCInteractor,
    StellarAddressOrEmptySchema,
    StellarAddressSchema,
    StellarASPRegistryInteractor,
    StellarCryptoService,
    StellarProofService,
    StellarRelayerInteractor,
    TokenIdFieldSchema,
    WitnessPreparationService,
} from "../../internal.js";

/** Any signed-in relayer method throws when relaying was never configured — see the class doc. */
function createUnconfiguredRelayerInteractor(): IRelayerInteractor<StellarAddress> {
    return new Proxy({} as IRelayerInteractor<StellarAddress>, {
        get(_target, prop) {
            return (): never => {
                throw new InvalidBuilderConfig(
                    `Relaying is not configured — supply \`relayers\` or a \`relayerInteractor\` ` +
                        `override to use ${String(prop)}()`,
                );
            };
        },
    });
}

function buildStorageService(cfg?: PersistentStorageConfig): IStorageService | undefined {
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
        default:
            return undefined;
    }
}

/**
 * One-call builder for a Stellar {@link PoolSession} — the Stellar counterpart to
 * {@link PoolSessionBuilder}, wiring every default service from a flat config object and
 * delegating to {@link createStellarPoolSession}.
 *
 * Deliberately simpler than `PoolSessionBuilder`: there is no fluent `.withX()` override chain
 * (every injectable dependency is a plain optional config field instead) and no
 * `DEPLOYMENTS[chainId]` registry lookup (nothing is deployed yet, so contract IDs are always
 * required directly). A caller needing finer control — partial sessions, custom service graphs —
 * should bypass this and call {@link createStellarPoolSession} directly, exactly as
 * `PoolSessionBuilder`'s own doc comment recommends for EVM.
 *
 * `relayerInteractor` defaults to a {@link StellarRelayerInteractor} when `relayers` is supplied,
 * or a stub that throws on every method when neither `relayers` nor a `relayerInteractor`
 * override is supplied. `StellarRelayerInteractor` only supports the relayed-withdrawal path
 * (`getWithdrawalQuote`/`relayWithdrawal`) — the one flow the reference relayer service
 * actually implements; every other relayer method throws (see its class doc for why each is
 * unsupported, including batch withdrawal — see `StellarRelayBatchCodec`'s doc comment).
 * deposit/transact self-submit/ragequit/keystore are unaffected either way.
 *
 * Deliberately a static-factory class, not a plain exported function — matches evm-sdk's
 * `PoolSessionBuilder` convention (this package's own CLAUDE.md §2 lists "static factory
 * methods" as an allowed class shape).
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- see doc comment above.
export class StellarPoolSessionBuilder {
    /**
     * Assembles every SDK service and returns a fully wired Stellar {@link PoolSession}.
     *
     * @param config - Builder configuration.
     * @returns A fully initialized PoolSession.
     * @throws {InvalidBuilderConfig} When the config fails structural validation or cross-field constraints.
     */
    static async create(
        config: StellarPoolSessionBuilderConfig,
    ): Promise<StellarPoolSession> {
        const logger = config.logger;
        const readSourcePublicKey = config.readSourcePublicKey ?? config.ownerAddress;
        const deploymentLedger = config.deploymentLedger
            ? BigInt(config.deploymentLedger)
            : undefined;

        const rpcInteractor = new SorobanRPCInteractor(
            {
                rpcUrl: config.rpcUrl,
                networkPassphrase: config.networkPassphrase,
                receiptPollIntervalMs: config.receiptPollIntervalMs,
            },
            { logger },
        );

        const walletInteractor = StellarPoolSessionBuilder.buildWalletInteractor(
            config.walletInteractor,
            { rpcInteractor, networkPassphrase: config.networkPassphrase },
        );

        const entrypointInteractor = createStellarEntrypointInteractor(
            {
                rpcInteractor,
                contractId: config.poolContractId,
                aspRegistryContractId: config.aspRegistryContractId,
                readSourcePublicKey,
                deploymentLedger,
            },
            { walletInteractor },
        );

        const keystoreInteractor = createStellarKeystoreInteractor(
            {
                rpcInteractor,
                contractId: config.keystoreContractId,
                readSourcePublicKey,
                deploymentLedger,
            },
            { walletInteractor, seed: config.keystoreLeafCacheSeed },
        );
        // Fire-and-forget warm-up — see PoolSessionBuilder.create's identical rationale: a cold
        // leaf scan can take seconds, long enough to blow through a relayer's short-lived signed
        // fee commitment if it only starts once proof-building begins.
        void keystoreInteractor.getKeystoreLeaves().catch(() => {
            /* swallowed on purpose — see comment above */
        });

        const poolVaultInteractor = createStellarPoolVaultInteractor(
            {
                rpcInteractor,
                contractId: config.poolContractId,
                readSourcePublicKey,
                deploymentLedger,
            },
            { logger, walletInteractor, seed: config.stateLeafCacheSeed },
        );
        void poolVaultInteractor.getStateLeaves().catch(() => {
            /* swallowed on purpose — see comment above */
        });

        const aspRegistryInteractor = new StellarASPRegistryInteractor({
            rpcInteractor,
            contractId: config.aspRegistryContractId,
            readSourcePublicKey,
        });

        const cryptoService: ICryptoService<StellarDeriveFromSignatureConfig> = new StellarCryptoService();
        // NoteComputationService/PaymentRequestService only use ICryptoService's chain-agnostic
        // members (ecdh/encrypt/decrypt/generateSecret/derivePaymentRequestKeyPair), never
        // `deriveKeysFromSignature` — so, like core-sdk's own `PoolSessionFactory.create`, they
        // stay typed against the plain default rather than threading the derive-config type
        // everywhere. Same documented EVM-only-boundary pattern used throughout this file for
        // ownerAddress.
        const genericCryptoService = cryptoService as unknown as ICryptoService;
        const hashService = await PoseidonHashService.create();
        const merkleService = new MerkleService({ hashService }, { logger });
        const noteComputationService = new NoteComputationService(
            { hashService, cryptoService: genericCryptoService, tokenIdFieldSchema: TokenIdFieldSchema },
            { logger },
        );
        const httpClient = new HTTPClient(config.httpClientConfig, { logger });

        const aspDataProvider =
            config.aspDataProvider ??
            new IpfsASPDataProvider(
                { ipfsGatewayUrl: config.ipfsGatewayUrl, aspRegistryInteractor, httpClient },
                { logger },
            );
        const aspClient =
            config.aspClient ??
            new ASPClient(
                {
                    providers: [aspDataProvider],
                    merkleService,
                    aspRegistryInteractor,
                    publicKey: config.aspPublicKey,
                },
                { logger },
            );

        const circuitArtifacts = StellarPoolSessionBuilder.resolveCircuitArtifacts(config, {
            httpClient,
            logger,
        });
        const proofService = new StellarProofService({
            circuitArtifacts,
            groth16Prover: new Groth16Prover(),
        });
        const witnessPreparationService = new WitnessPreparationService(
            {
                noteComputationService,
                hashService,
                merkleService,
                addressSchema: StellarAddressOrEmptySchema,
            },
            { logger },
        );

        const keystoreManager = StellarPoolSessionBuilder.resolveKeystoreManager(config);

        const sharedStorage = buildStorageService(config.persistentStorage);
        const noteStorageAdapter = sharedStorage
            ? new NoteStorageAdapter(
                  config.chainId,
                  sharedStorage,
                  config.ownerAddress as unknown as Address,
              )
            : undefined;
        const paymentRequestStorageAdapter = sharedStorage
            ? new PaymentRequestStorageAdapter(
                  config.chainId,
                  sharedStorage,
                  config.ownerAddress as unknown as Address,
              )
            : undefined;

        const noteManager =
            config.noteManager ??
            new NoteManager<StellarAddress>(
                { addressSchema: StellarAddressSchema },
                { logger, storageAdapter: noteStorageAdapter },
            );
        if (noteStorageAdapter && !config.noteManager) {
            await noteManager.loadFromStorage();
        }

        const paymentRequestService =
            config.paymentRequestService ??
            new PaymentRequestService(
                {
                    ownerAddress: config.ownerAddress as Address,
                    cryptoService: genericCryptoService,
                    hashService,
                    noteComputationService,
                    keystoreManager,
                    storageAdapter:
                        paymentRequestStorageAdapter ??
                        new PaymentRequestStorageAdapter(
                            config.chainId,
                            new InMemoryStorageService(),
                            config.ownerAddress as unknown as Address,
                        ),
                },
                { logger },
            );
        if (paymentRequestStorageAdapter && !config.paymentRequestService) {
            await paymentRequestService.loadFromStorage();
        }

        const relayerInteractor =
            config.relayerInteractor ??
            (config.relayers && config.relayers.length > 0
                ? new StellarRelayerInteractor(
                      { relayers: config.relayers, httpClient, addressSchema: StellarAddressSchema, proofService },
                      { logger },
                  )
                : createUnconfiguredRelayerInteractor());

        return createStellarPoolSession(
            {
                ownerAddress: config.ownerAddress,
                chainId: config.chainId,
                networkPassphrase: config.networkPassphrase,
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
                paymentRequestService,
                yield: config.yieldDeployments?.length
                    ? {
                          deployments: config.yieldDeployments,
                          rpcInteractor,
                          readSourcePublicKey,
                          poolContractId: config.poolContractId,
                          aspRegistryContractId: config.aspRegistryContractId,
                          walletInteractor,
                      }
                    : undefined,
            },
            { logger },
        );
    }

    private static buildWalletInteractor(
        cfg: StellarWalletInteractorConfig | undefined,
        deps: { rpcInteractor: SorobanRPCInteractor; networkPassphrase: string },
    ): IStellarWalletInteractor | undefined {
        if (!cfg) return undefined;
        switch (cfg.type) {
            case "keypair":
                return new KeypairWalletInteractor({
                    keypair: Keypair.fromSecret(cfg.secretKey),
                    networkPassphrase: deps.networkPassphrase,
                    rpcInteractor: deps.rpcInteractor,
                });
            case "freighter":
                return new FreighterWalletInteractor({
                    provider: cfg.provider ?? createFreighterProvider(),
                    networkPassphrase: deps.networkPassphrase,
                    rpcInteractor: deps.rpcInteractor,
                });
        }
    }

    private static resolveCircuitArtifacts(
        config: StellarPoolSessionBuilderConfig,
        deps: { httpClient: IHTTPClient; logger?: StellarPoolSessionBuilderConfig["logger"] },
    ): ICircuitArtifacts {
        if (config.circuitArtifacts) return config.circuitArtifacts;
        if (config.circuitArtifactsDir !== undefined) {
            return new LocalCircuitArtifacts({ baseDir: config.circuitArtifactsDir });
        }
        if (config.circuitManifest === undefined || config.circuitGatewayUrls === undefined) {
            throw new InvalidBuilderConfig(
                "Supply `circuitArtifactsDir`, both `circuitGatewayUrls` and `circuitManifest`, " +
                    "or a `circuitArtifacts` override.",
            );
        }
        return new IpfsCircuitArtifacts(
            {
                ipfsGatewayUrls: config.circuitGatewayUrls,
                circuitManifest: config.circuitManifest,
                httpClient: deps.httpClient,
            },
            { logger: deps.logger },
        );
    }

    private static resolveKeystoreManager(config: StellarPoolSessionBuilderConfig): IKeystoreManager {
        if (config.keystoreManager) return config.keystoreManager;
        if (config.protocolKeys === undefined) {
            throw new InvalidBuilderConfig(
                "protocolKeys is required unless a keystoreManager override is supplied",
            );
        }
        // curve defaults to "x25519" — Stellar's viewing key uses the same curve as EVM now
        // (see StellarPublicKeySchema's doc comment for why the earlier secp256k1 choice was
        // reverted), so no override is needed here.
        return new KeystoreManager({ ...config.protocolKeys });
    }
}
