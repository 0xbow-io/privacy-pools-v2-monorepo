import { Account, Chain, Transport, WalletClient } from "viem";

import type {
    Address,
    CircuitManifest,
    EIP1193Provider,
    Hex,
    HTTPClientConfig,
    ILogger,
    LeafCacheSeed,
    PublicKey,
    RelayerInfo,
    Secret,
} from "../internal.js";

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
/**
 * Declarative wallet interactor selecto for `ContractInteractors`.
 *
 * The builder translates this into a `IWalletInteractor`
 * Integrators who need a custom wallet interactor can bypass
 * this and supply their own via `.withWalletInteractor()
 */
export type WalletInteractorConfig =
    | {
          type: "viem";
          walletClient: WalletClient<Transport, Chain, Account>;
      }
    | {
          type: "EIP1193";
          provider: EIP1193Provider;
      };

/**
 * Canonical Privacy Pools V2 contract addresses for a given chain.
 *
 * Stored in the {@link DEPLOYMENTS} map keyed by chainId so
 * `PoolSessionBuilder` can derive all on-chain targets from `chainId` alone.
 */
export interface DeploymentAddresses {
    /** PoolVault contract address. */
    poolAddress: Address;
    /** Entrypoint contract address. */
    entrypointAddress: Address;
    /** Keystore contract address. */
    keystoreAddress: Address;
    /** ASP registry contract address (used by the IPFS ASP data provider). */
    aspRegistryAddress: Address;
    /** RelaySwaps processor contract — used as the canonical router allowlist source. */
    relaySwapsAddress: Address;
}

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
 * Fields shared between {@link PoolSessionBuilderConfig} and
 * {@link PoolSessionSimpleConfig}. Every field listed here has the same
 * required/optional status in both variants — fields that flip between
 * required and optional live on the composing types instead.
 */
interface PoolSessionBuilderBaseConfig {
    /** Chain ID the session operates on. */
    chainId: number;
    /** JSON-RPC endpoint URL used by all contract interactors. */
    rpcUrl: string;
    /** Account owner's Ethereum address. */
    ownerAddress: Address;
    /** On-chain contract addresses for the target chain. When omitted, resolved from `DEPLOYMENTS[chainId]`. */
    deployment?: DeploymentAddresses;
    /** Earliest block to scan for contract events. Skips empty blocks before deployment. When omitted, scans from block 0. */
    deploymentBlock?: Hex;
    /** Optional ASP public key. When omitted, `ASPClient` fetches it from the provider on first use. */
    aspPublicKey?: PublicKey;
    /** Optional logger shared across all services and sub-sessions. */
    logger?: ILogger;
    /** Optional HTTP client configuration (timeouts, retries, default headers). */
    httpClientConfig?: HTTPClientConfig;
    /** Optional persistent-storage selector for `NoteManager`. Mutually exclusive with `.withStorageService()` / `.withNoteStorageAdapter()`. */
    persistentStorage?: PersistentStorageConfig;
    /** Optional wallet interactor selector. Mutually exclusive with `.withWalletInteractor() */
    walletInteractor?: WalletInteractorConfig;
    /**
     * Optional destination chain ID for `PoolSessionReshieldCrosschain`. When
     * provided, the builder wires a second Entrypoint interactor (its own RPC
     * connection — see `destinationRpcUrl`) so the session can validate and
     * target the destination chain's pool deployment. Omitted by default —
     * `reshieldCrosschain` is unavailable unless both this and
     * `destinationRpcUrl` are supplied.
     */
    destinationChainId?: number;
    /** JSON-RPC endpoint URL for `destinationChainId`. Required when `destinationChainId` is supplied. */
    destinationRpcUrl?: string;
    /** On-chain contract addresses for `destinationChainId`. When omitted, resolved from `DEPLOYMENTS[destinationChainId]`. */
    destinationDeployment?: DeploymentAddresses;
    /**
     * Optional source-chain attachment for cross-chain swap-and-deposit: the input
     * token, its approval, and the LiFi transaction execute on this chain while the
     * deposit lands in the session's pool. All fields are explicit — the wallet must
     * be connected to `chainId`, and `relaySwapsAddress` is that chain's RelaySwaps
     * deployment (its `approvedRouters` vets the LiFi contracts the wallet will
     * approve and call). Omitted → `swapAndDeposit` is same-chain only.
     */
    sourceChain?: {
        chainId: number;
        rpcUrl: string;
        walletInteractor: WalletInteractorConfig;
        relaySwapsAddress: Address;
    };
    /**
     * Pre-warms `KeystoreInteractor`'s leaf-scan cache from a previously
     * exported snapshot (see `PoolSession.exportKeystoreLeafCache()`) so the
     * first scan is a delta-fetch instead of a full from-`deploymentBlock`
     * scan. Ignored when a `KeystoreInteractor` override is supplied via
     * `.withKeystoreInteractor()` — the override already owns its own cache
     * state. The SDK never persists this itself; loading/saving the seed is
     * entirely the caller's concern.
     */
    keystoreLeafCacheSeed?: LeafCacheSeed;
    /** Same as `keystoreLeafCacheSeed`, for `PoolVaultInteractor`'s state-tree leaf cache. Ignored when a `PoolVaultInteractor` override is supplied via `.withVaultInteractor()`. */
    stateLeafCacheSeed?: LeafCacheSeed;
}

/**
 * Minimal config consumed by `PoolSessionBuilder.fromConfig(config)`.
 *
 * Contract addresses are derived from `chainId` via the `DEPLOYMENTS`
 * constant — integrators never pass raw addresses. Any dependency can be
 * overridden through the builder's fluent `.withX()` methods.
 */
export type PoolSessionBuilderConfig = PoolSessionBuilderBaseConfig & {
    /** Pre-derived key material. Not required when a `KeystoreManager` override is supplied via `.withKeystoreManager()`. */
    protocolKeys?: ProtocolKeys;
    /** HTTP ASP base URL. Not required when an `AspClient` / `AspDataProvider` override is supplied, or when `ipfsGatewayUrl` is provided. */
    aspUrl?: string;
    /** Known relayers for submitting transfer/withdraw transactions. Not required when a `RelayerInteractor` override is supplied. Must contain at least one entry when supplied. */
    relayers?: RelayerInfo[];
    /** Optional filesystem path for `LocalCircuitArtifacts`. Mutually exclusive with `circuitGatewayUrls`. Not required when a `CircuitArtifacts` override is supplied. */
    circuitArtifactsDir?: string;
    /** Optional IPFS gateway URLs for `IpfsCircuitArtifacts`. Tried in order on fetch failure. Mutually exclusive with `circuitArtifactsDir`. Not required when a `CircuitArtifacts` override is supplied. */
    circuitGatewayUrls?: string[];
    /** Per-circuit CID manifest for `IpfsCircuitArtifacts`. Required on the IPFS path — there is no silent default (audit M-11): pass `DEFAULT_CIRCUIT_MANIFEST` explicitly to use the SDK-shipped pins, accepting that proof correctness is then tied to the SDK package version. */
    circuitManifest?: CircuitManifest;
    /** Optional IPFS gateway URL for `IpfsASPDataProvider`. When provided (without an `AspDataProvider` override), the builder uses the IPFS ASP data provider instead of HTTP. */
    ipfsGatewayUrl?: string;
};

/**
 * Narrowed config for the one-call `PoolSessionBuilder.create(config)` path.
 *
 * The simple path has no fluent `.withX()` overrides available, so every
 * dependency that the builder would otherwise resolve from an override MUST
 * come from config. Compared to {@link PoolSessionBuilderConfig}:
 *
 * - `protocolKeys`, `relayers` are required.
 * - Exactly one of `aspUrl` / `ipfsGatewayUrl` must be present (XOR).
 * - Exactly one of `circuitArtifactsDir` / `circuitGatewayUrls` must be
 *   present. The IPFS arm also requires `circuitManifest` — there is no
 *   silent default (audit M-11): pass `DEFAULT_CIRCUIT_MANIFEST` explicitly
 *   to use the SDK-shipped pins, accepting that proof correctness is then
 *   tied to the SDK package version.
 * - `deployment` stays optional — `DEPLOYMENTS[chainId]` is the fallback.
 */
export type PoolSessionSimpleConfig = PoolSessionBuilderBaseConfig & {
    /** Pre-derived key material. */
    protocolKeys: ProtocolKeys;
    /** Known relayers for submitting transfer/withdraw transactions. Must contain at least one entry. */
    relayers: RelayerInfo[];
} & ({ aspUrl: string; ipfsGatewayUrl?: never } | { aspUrl?: never; ipfsGatewayUrl: string }) &
    (
        | {
              /** Filesystem path for `LocalCircuitArtifacts`. */
              circuitArtifactsDir: string;
              circuitGatewayUrls?: never;
              circuitManifest?: never;
          }
        | {
              /** IPFS gateway URLs for `IpfsCircuitArtifacts`. */
              circuitArtifactsDir?: never;
              circuitGatewayUrls: string[];
              /** Per-circuit CID manifest. See {@link PoolSessionBuilderConfig.circuitManifest} for why this is required. */
              circuitManifest: CircuitManifest;
          }
    );
