import type {
    IASPDataProvider,
    IASPRegistryInteractor,
    ICryptoService,
    IHTTPClient,
    ILogger,
    IMerkleService,
    Secret,
} from "../internal.js";
import type { Address } from "./Address.js";
import type { Hash } from "./Hash.js";
import type { Hex } from "./Hex.js";
import type { PublicKey } from "./PublicKey.js";

/**
 * Status of a label as reported by the ASP.
 */
export interface LabelStatus {
    /** Current status of the label. */
    status: "pending" | "approved" | "rejected" | "poi_required" | "unknown";
    /** Optional timestamp of the last status update. */
    timestamp?: number;
}

/**
 * Configuration for the ASPClient service.
 */
export interface ASPClientConfig {
    /** Ordered list of data providers (first = primary, fallback chain). Must have at least 1. */
    providers: IASPDataProvider[];
    /** Service for local Merkle proof generation and root computation. */
    merkleService: IMerkleService;
    /**
     * On-chain ASP registry interactor. Used to fetch `latestASPRoot` as the
     * trust anchor for cross-checking leaves returned by data providers.
     */
    aspRegistryInteractor: IASPRegistryInteractor;
    /**
     * If provided, getASPPublicKey() returns this value without querying
     * providers. Pin it in production. See `IASPClient.getASPPublicKey` for why.
     */
    publicKey?: PublicKey;
}

/**
 * Dependencies for the ASPClient service.
 */
export interface ASPClientDependencies {
    logger?: ILogger;
}

/**
 * Configuration for the HTTP ASP data provider.
 *
 * `entrypointAddress` is a plain string, not the EVM-typed `Address` — the ASP's HTTP API (see
 * `@privacy-pools-v2/mock-asp`'s `ChainScope.entrypoint`) treats it as an opaque scoping string in
 * a query param, with no chain-specific format validation, so any chain's address string (EVM hex
 * or a Stellar StrKey contract id) round-trips through it unchanged.
 */
export interface HttpASPDataProviderConfig {
    /** Base URL of the ASP HTTP API. */
    aspUrl: string;
    /** Chain ID to query. */
    chainId: number;
    /**
     * Entrypoint contract address of the target pool, in that chain's own address format. The
     * ASP can serve several pools on one chain (e.g. an abandoned deployment next to the live
     * one), so every chain-scoped query carries this to select the right association set and
     * event stream.
     */
    entrypointAddress: string;
    /** HTTP client for making requests. */
    httpClient: IHTTPClient;
}

/**
 * Dependencies for the HTTP ASP data provider.
 */
export interface HttpASPDataProviderDependencies {
    logger?: ILogger;
}

/**
 * Configuration for the IPFS ASP data provider.
 */
export interface IpfsASPDataProviderConfig {
    /** Base URL of the IPFS gateway (e.g. "https://gateway.pinata.cloud/ipfs"). */
    ipfsGatewayUrl: string;
    /** Interactor for reading ASP registry on-chain data. */
    aspRegistryInteractor: IASPRegistryInteractor;
    /** HTTP client for making requests. */
    httpClient: IHTTPClient;
}

/**
 * Dependencies for the IPFS ASP data provider.
 */
export interface IpfsASPDataProviderDependencies {
    logger?: ILogger;
}

/**
 * Payload for an ASP cipher text.
 */
export interface ASPCipherTextPayload {
    noteAddressHash: Hash;
    tokenId: Address;
    value: Hex;
    depositSecret: Hex;
    metadata: Hex;
}

export interface EncodingKeys {
    aspPublicKey: PublicKey;
}

export interface DecodingKeys {
    aspPrivateKey: Secret;
}

export interface UtilsDependencies {
    /**
     * The chain's crypto service, used for the ephemeral-ECDH encryption scheme. Required —
     * unlike `logger`, there is no chain-agnostic default to fall back to (see the removed
     * `CryptoService` default in the pre-split `packages/sdk`: it silently pulled in an
     * EVM-concrete class from what is otherwise generic code).
     */
    cryptoService: ICryptoService;
    logger?: ILogger;
}
