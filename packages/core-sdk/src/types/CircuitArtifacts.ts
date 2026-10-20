import type { ICacheStore, IHTTPClient, ILogger } from "../internal.js";

/**
 * Per-artifact IPFS CIDs for a single circuit. Optional `*Sha256` fields, when
 * supplied, are checked against the SHA-256 of the fetched bytes before the
 * artifact is returned or cached — protects against a compromised gateway
 * serving substituted WASM / proving key / verification key.
 */
export type CircuitArtifactCIDs = Readonly<{
    /** CID of the compiled WASM. */
    wasm: string;
    /** Expected SHA-256 of the WASM bytes (`0x`-prefixed lowercase hex). */
    wasmSha256?: string;
    /** CID of the Groth16 proving key (zkey). */
    provingKey: string;
    /** Expected SHA-256 of the proving-key bytes. */
    provingKeySha256?: string;
    /** CID of the Groth16 verification key (JSON). */
    verificationKey: string;
    /** Expected SHA-256 of the verification-key bytes. */
    verificationKeySha256?: string;
}>;

/**
 * Map of circuit name to its IPFS artifact CIDs.
 */
export type CircuitManifest = Readonly<Record<string, CircuitArtifactCIDs>>;

/**
 * Configuration for {@link LocalCircuitArtifacts}.
 */
export interface LocalCircuitArtifactsConfig {
    /** Base directory containing the per-circuit artifact subdirectories. */
    baseDir: string;
}

/**
 * Configuration for {@link IpfsCircuitArtifacts}.
 */
export interface IpfsCircuitArtifactsConfig {
    /**
     * One or more IPFS gateway base URLs (e.g. `["https://gateway.pinata.cloud/ipfs"]`).
     * Tried in order on fetch failure. At least one URL is required.
     * For auth (e.g. Pinata dedicated gateway tokens), inject headers via
     * the `httpClient` instance rather than appending query strings.
     */
    ipfsGatewayUrls: string[];
    /** Per-circuit CID manifest. Captured by deep-clone at construction. */
    circuitManifest: CircuitManifest;
    /** HTTP client used to fetch binary artifacts from the gateway. */
    httpClient: IHTTPClient;
}

/**
 * Optional dependencies for {@link IpfsCircuitArtifacts}.
 */
export interface IpfsCircuitArtifactsDependencies {
    /** Optional cache store (defaults to in-memory). */
    cacheStore?: ICacheStore;
    logger?: ILogger;
}
