import type {
    CircuitManifest,
    Hex,
    HTTPClientConfig,
    IASPClient,
    IASPDataProvider,
    ICircuitArtifacts,
    IKeystoreManager,
    ILogger,
    INoteManager,
    IPaymentRequestService,
    IRelayerInteractor,
    LeafCacheSeed,
    PublicKey,
    RelayerInfo,
    Secret,
    StellarAddress,
    StellarWalletProvider,
    StellarYieldDeployment,
} from "../internal.js";

// NOTE (stellar-sdk split): PersistentStorageConfig / ProtocolKeys are not core-sdk exports —
// each chain-sdk owns its own copy (see evm-sdk's identical types/PoolSessionBuilder.ts), since
// core-sdk itself never defined a shared PoolSessionBuilder config shape. Content is
// chain-agnostic (no Stellar- or EVM-specific fields), so this is a verbatim duplicate of
// evm-sdk's definitions.

/**
 * Declarative persistent-storage selector for `NoteManager`.
 *
 * The builder translates this into an `IStorageService` + `NoteStorageAdapter`
 * pair internally. Integrators who need a custom storage backend can bypass
 * this and supply their own via `.withStorageService()` or
 * `.withNoteStorageAdapter()`.
 */
export type PersistentStorageConfig =
    | {
          /** File-backed storage (Node.js only). */
          type: "file";
          /** Directory where the JSON file is stored. Created if absent. */
          dirPath: string;
          /** Filename (without extension). Defaults to `"privacy-pool-notes"`. */
          filename?: string;
      }
    | {
          /** Browser `window.localStorage`-backed storage. */
          type: "local";
          /** Key prefix. Defaults to `"privacy-pool"`. */
          prefix?: string;
      }
    | {
          /** Ephemeral in-memory storage (lost on process exit — primarily for tests). */
          type: "memory";
      };

/** Pre-derived key material required to initialize a `PoolSession`. */
export interface ProtocolKeys {
    /** Private nullifying key used to derive nullifiers when spending notes. */
    privateNullifyingKey: Secret;
    /** Private revocable key used for authorization updates. */
    privateRevocableKey: Secret;
    /** Rotation index `n` matching `privateRevocableKey`, as 0x-prefixed hex. Pass `"0x0"` for a fresh account. */
    revocableKeyIndex: Hex;
    /** Private viewing key used to decrypt incoming note payloads. */
    viewingPrivateKey: Secret;
    /** Public viewing key published on-chain so others can encrypt notes for this account. */
    viewingPublicKey: PublicKey;
}

/**
 * Declarative wallet-interactor selector for `StellarPoolSessionBuilder`. Mirrors
 * `WalletInteractorConfig`'s role for EVM, but over Stellar's two wallet interactors
 * (`KeypairWalletInteractor`/`FreighterWalletInteractor`) instead.
 */
export type StellarWalletInteractorConfig =
    | {
          /** Raw-`Keypair`-backed signing — relayer/service-account/test use, not end-user wallets. */
          type: "keypair";
          /** StrKey-encoded ed25519 secret seed ("S..."). */
          secretKey: string;
      }
    | {
          /** Browser-extension wallet (e.g. Freighter), via an injected minimal provider. */
          type: "freighter";
          /** Defaults to `createFreighterProvider()` (the real `@stellar/freighter-api` package) when omitted. */
          provider?: StellarWalletProvider;
      };

/**
 * Configuration for `StellarPoolSessionBuilder.create(config)`.
 *
 * Unlike `PoolSessionBuilder`, there is no `DEPLOYMENTS[chainId]` registry to resolve contract
 * IDs from yet (nothing is deployed), so `poolContractId`/`keystoreContractId`/
 * `aspRegistryContractId` are always required directly. There is also no fluent `.withX()`
 * override chain — every injectable dependency is a plain optional config field instead; a
 * caller needing finer control than that should call `createStellarPoolSession` directly (the
 * same escape hatch `PoolSessionBuilder`'s own doc comment describes).
 */
export interface StellarPoolSessionBuilderConfig {
    /**
     * An arbitrary, stable per-deployment identifier — Stellar has no native numeric chain ID.
     * Used only for storage-key namespacing (`NoteStorageAdapter`/`PaymentRequestStorageAdapter`,
     * both still concretely EVM-`chainId`-shaped); pick any value and keep it stable across
     * sessions for the same deployment, or a stored note/payment-request state becomes unreachable.
     */
    chainId: number;
    /** The account owner's StrKey address. */
    ownerAddress: StellarAddress;
    /** Soroban RPC endpoint URL. */
    rpcUrl: string;
    /** How often a submitted transaction is re-checked, in ms (`SorobanRPCInteractorConfig.receiptPollIntervalMs`). Default 2000. */
    receiptPollIntervalMs?: number;
    /** The network passphrase (e.g. `Networks.TESTNET`) this session operates on. */
    networkPassphrase: string;
    /** The pool contract ID — also used for deposit/entrypoint calls (see `StellarEntrypointChainAdapter`'s doc comment: no separate Entrypoint contract exists on Stellar). */
    poolContractId: string;
    /** The keystore contract ID. */
    keystoreContractId: string;
    /** The ASP registry contract ID. */
    aspRegistryContractId: string;
    /**
     * Any existing account used to build read-only simulation transactions (Soroban requires a
     * source account for every call, including reads — see `StellarContractInteractorConfig`).
     * Defaults to `ownerAddress` when omitted.
     */
    readSourcePublicKey?: string;
    /** Earliest ledger to scan for contract events. Omitted = `getEvents`' own recent-window fallback. */
    deploymentLedger?: string;
    /** Pre-derived key material. Not required when a `keystoreManager` override is supplied. */
    protocolKeys?: ProtocolKeys;
    /** Optional wallet-interactor selector. Omit for a read-only session (no deposit/transact/ragequit/keystore writes). */
    walletInteractor?: StellarWalletInteractorConfig;
    /** IPFS gateway URL for `IpfsASPDataProvider` — the only ASP data path this builder wires (see its own doc comment for why the HTTP/EVM-address-keyed path isn't offered here). */
    ipfsGatewayUrl: string;
    /** Optional ASP public key. When omitted, `ASPClient` fetches it from the provider on first use. */
    aspPublicKey?: PublicKey;
    /** Known relayers for submitting transfer/withdraw transactions. Omit if relaying is not needed yet — see `StellarRelayBatchCodec`'s doc comment. */
    relayers?: RelayerInfo<StellarAddress>[];
    /**
     * Yield deployments (router + share token + underlying) to expose as `session.yield` /
     * `session.yields`. Each share token must be registered as a pool asset.
     */
    yieldDeployments?: StellarYieldDeployment[];
    /** Optional filesystem path for `LocalCircuitArtifacts`. Mutually exclusive with `circuitGatewayUrls`. */
    circuitArtifactsDir?: string;
    /** Optional IPFS gateway URLs for `IpfsCircuitArtifacts`. Mutually exclusive with `circuitArtifactsDir`. */
    circuitGatewayUrls?: string[];
    /** Per-circuit CID manifest for `IpfsCircuitArtifacts`. Required on the IPFS path — see `PoolSessionBuilderConfig.circuitManifest`'s doc comment (audit M-11) for why there is no silent default. */
    circuitManifest?: CircuitManifest;
    /** Optional persistent-storage selector for `NoteManager`/`PaymentRequestService`. */
    persistentStorage?: PersistentStorageConfig;
    /** Optional HTTP client configuration (timeouts, retries, default headers). */
    httpClientConfig?: HTTPClientConfig;
    /** Optional logger shared across all services. */
    logger?: ILogger;
    /** Pre-warms `StellarKeystoreChainAdapter`'s leaf-scan cache — see `PoolSessionBuilderConfig.keystoreLeafCacheSeed`'s doc comment. */
    keystoreLeafCacheSeed?: LeafCacheSeed;
    /** Same as `keystoreLeafCacheSeed`, for the pool vault's state-tree leaf cache. */
    stateLeafCacheSeed?: LeafCacheSeed;
    /** Overrides `KeystoreManager`. Not required when `protocolKeys` is supplied. */
    keystoreManager?: IKeystoreManager;
    /** Overrides the ASP data provider (bypasses `ipfsGatewayUrl`). */
    aspDataProvider?: IASPDataProvider;
    /** Overrides `ASPClient` (bypasses `aspPublicKey`/`aspDataProvider`). */
    aspClient?: IASPClient;
    /** Overrides circuit artifact loading (bypasses `circuitArtifactsDir`/`circuitGatewayUrls`/`circuitManifest`). */
    circuitArtifacts?: ICircuitArtifacts;
    /** Overrides `NoteManager`. */
    noteManager?: INoteManager<StellarAddress>;
    /** Overrides `PaymentRequestService`. */
    paymentRequestService?: IPaymentRequestService;
    /** Overrides the relayer interactor (bypasses `relayers`). */
    relayerInteractor?: IRelayerInteractor<StellarAddress>;
}
