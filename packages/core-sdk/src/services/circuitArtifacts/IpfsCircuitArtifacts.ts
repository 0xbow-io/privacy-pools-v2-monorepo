import { bytesToHex } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";

import type {
    CircuitArtifactCIDs,
    ICacheStore,
    ICircuitArtifacts,
    IHTTPClient,
    ILogger,
    IpfsCircuitArtifactsConfig,
    IpfsCircuitArtifactsDependencies,
} from "../../internal.js";
import {
    CID_CODEC_DAG_PB,
    CID_CODEC_RAW,
    CircuitArtifactLoadFailed,
    CircuitArtifactMultihashMismatch,
    InMemoryCacheStore,
    parseCID,
    SHA256_OF_EMPTY_INPUT,
    verifyBytesAgainstCID,
} from "../../internal.js";

type ArtifactKind = "wasm" | "provingKey" | "verificationKey";
type GatewayAttempt = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

/** 32-byte hex digest, optional 0x prefix — the format `verifyArtifactContent` compares against. */
const SHA256_HEX_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * IPFS-backed implementation of {@link ICircuitArtifacts}. Fetches WASM,
 * proving keys, and verification keys from one or more IPFS gateways by CID.
 * Drop-in replacement for `LocalCircuitArtifacts` in browser and serverless
 * runtimes.
 *
 * - Tries gateways in order; falls back on each failure.
 * - Coalesces concurrent fetches of the same CID into a single network call.
 * - Caches successful responses via the supplied (or default in-memory)
 *   {@link ICacheStore}. Cache write failures are logged and swallowed.
 */
export class IpfsCircuitArtifacts implements ICircuitArtifacts {
    private readonly ipfsGatewayUrls: string[];
    private readonly circuitManifest: Map<string, CircuitArtifactCIDs>;
    private readonly httpClient: IHTTPClient;
    private readonly cacheStore: ICacheStore;
    private readonly logger?: ILogger;
    private readonly inFlight = new Map<string, Promise<Uint8Array>>();

    /**
     * Creates a new IpfsCircuitArtifacts instance.
     * @param config - Gateway URLs, circuit manifest, and HTTP client.
     * @param dependencies - Optional dependencies (cache store, logger).
     *     Defaults to an in-memory cache when `cacheStore` is omitted.
     * @throws {CircuitArtifactLoadFailed} If `ipfsGatewayUrls` is empty or contains an invalid URL.
     */
    constructor(
        config: IpfsCircuitArtifactsConfig,
        dependencies?: IpfsCircuitArtifactsDependencies,
    ) {
        this.ipfsGatewayUrls = this.validateGatewayUrls(config.ipfsGatewayUrls);
        // Deep-clone manifest so post-construction mutation by the caller does
        // not bleed into our captured state.
        this.circuitManifest = new Map(
            Object.entries(config.circuitManifest).map(([k, v]) => [k, { ...v }]),
        );
        this.httpClient = config.httpClient;
        this.cacheStore = dependencies?.cacheStore ?? new InMemoryCacheStore();
        this.logger = dependencies?.logger;

        // Reject malformed CIDs up front — a manifest with bad pins is a
        // deployment error, and discovering it at first-fetch time is
        // strictly worse than at builder construction.
        this.validateManifestCIDs();

        this.logger?.debug("IpfsCircuitArtifacts initialized", {
            ipfsGatewayUrls: this.ipfsGatewayUrls,
            circuits: this.circuitManifest.size,
        });
    }

    /**
     * @inheritdoc ICircuitArtifacts.getWasm
     * @throws {CircuitArtifactLoadFailed} If the circuit is unknown, the CID is unpinned, or every gateway fails.
     */
    async getWasm(circuitName: string): Promise<Uint8Array> {
        return this.fetchArtifact(circuitName, "wasm");
    }

    /**
     * @inheritdoc ICircuitArtifacts.getProvingKey
     * @throws {CircuitArtifactLoadFailed} If the circuit is unknown, the CID is unpinned, or every gateway fails.
     */
    async getProvingKey(circuitName: string): Promise<Uint8Array> {
        return this.fetchArtifact(circuitName, "provingKey");
    }

    /**
     * @inheritdoc ICircuitArtifacts.getVerificationKey
     * @throws {CircuitArtifactLoadFailed} If the circuit is unknown, the CID is unpinned, or every gateway fails.
     */
    async getVerificationKey(circuitName: string): Promise<Uint8Array> {
        return this.fetchArtifact(circuitName, "verificationKey");
    }

    private async fetchArtifact(circuitName: string, kind: ArtifactKind): Promise<Uint8Array> {
        const { cid, expectedSha256 } = this.resolveCid(circuitName, kind);
        const cached = await this.cacheStore.get(cid);
        if (cached) {
            // Re-verify cache hits so a poisoned cache cannot serve substituted
            // bytes. Multihash is the primary check (always-on, derived from
            // the CID itself); the optional `expectedSha256` adds a second
            // pin for integrators who want belt-and-suspenders.
            this.verifyArtifactContent(cached, cid, expectedSha256, circuitName, kind);
            return cached;
        }
        return this.coalescedFetch(cid, circuitName, kind, expectedSha256);
    }

    private resolveCid(
        circuitName: string,
        kind: ArtifactKind,
    ): { cid: string; expectedSha256: string | undefined } {
        const entry = this.circuitManifest.get(circuitName);
        if (!entry) {
            throw new CircuitArtifactLoadFailed(`Unknown circuit: "${circuitName}"`);
        }
        const cid = entry[kind];
        if (cid === "") {
            throw new CircuitArtifactLoadFailed(
                `No CID pinned for circuit "${circuitName}" artifact "${kind}"`,
            );
        }
        const expectedSha256 = entry[`${kind}Sha256`];
        return { cid, expectedSha256 };
    }

    /** Coalesce concurrent fetches of the same CID into a single network call. */
    private async coalescedFetch(
        cid: string,
        circuitName: string,
        kind: ArtifactKind,
        expectedSha256: string | undefined,
    ): Promise<Uint8Array> {
        const existing = this.inFlight.get(cid);
        if (existing) {
            return existing;
        }
        const promise = this.fetchAndCache(cid, circuitName, kind, expectedSha256);
        this.inFlight.set(cid, promise);
        try {
            return await promise;
        } finally {
            this.inFlight.delete(cid);
        }
    }

    private async fetchAndCache(
        cid: string,
        circuitName: string,
        kind: ArtifactKind,
        expectedSha256: string | undefined,
    ): Promise<Uint8Array> {
        const errors: string[] = [];

        for (const gateway of this.ipfsGatewayUrls) {
            const attempt = await this.tryGateway(gateway, cid, circuitName, kind);
            if (!attempt.ok) {
                errors.push(`${gateway}: ${attempt.error}`);
                continue;
            }
            try {
                this.verifyArtifactContent(attempt.bytes, cid, expectedSha256, circuitName, kind);
            } catch (verifyError) {
                const message =
                    verifyError instanceof Error ? verifyError.message : String(verifyError);
                errors.push(`${gateway}: ${message}`);
                continue;
            }
            await this.persistToCache(cid, attempt.bytes, circuitName, kind);
            return attempt.bytes;
        }

        throw new CircuitArtifactLoadFailed(
            `Failed to fetch circuit "${circuitName}" artifact "${kind}" from any IPFS gateway: ${errors.join("; ")}`,
        );
    }

    /**
     * Integrity check on fetched circuit artifact bytes. Which digest anchors
     * the check depends on the CID codec (see `ParsedCID`):
     *
     * - **Raw CID (`CID_CODEC_RAW`).** The CID digest is the SHA-256 of the
     *   file bytes, so we verify against the CID itself. A manifest
     *   `expectedSha256`, when present, is checked as a second independent pin.
     * - **dag-pb CID (`CID_CODEC_DAG_PB`).** The CID digest covers a UnixFS
     *   block, not the file bytes, so the CID cannot verify gateway-served
     *   content. The manifest `expectedSha256` is the integrity anchor
     *   instead — `validateManifestCIDs` rejects dag-pb entries without one
     *   at construction, so it is always present here.
     *
     * Any failure throws so the gateway-fallback loop tries the next gateway;
     * if every gateway fails, `CircuitArtifactLoadFailed` (or its subclass
     * `CircuitArtifactMultihashMismatch`) escapes up the stack.
     */
    private verifyArtifactContent(
        bytes: Uint8Array,
        cid: string,
        expectedSha256: string | undefined,
        circuitName: string,
        kind: ArtifactKind,
    ): void {
        if (parseCID(cid).codec === CID_CODEC_RAW) {
            try {
                verifyBytesAgainstCID(bytes, cid);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new CircuitArtifactMultihashMismatch(
                    `Multihash mismatch for circuit "${circuitName}" artifact "${kind}" (CID ${cid}): ${message}`,
                );
            }
        }

        if (!expectedSha256) return;
        const expected = expectedSha256.toLowerCase().replace(/^0x/, "");
        const actual = bytesToHex(sha256(bytes));
        if (actual !== expected) {
            throw new CircuitArtifactLoadFailed(
                `Hash mismatch for circuit "${circuitName}" artifact "${kind}": expected sha256=${expected}, got ${actual}`,
            );
        }
    }

    /**
     * Parses every non-empty CID in the manifest at construction time so
     * malformed pins fail loudly here rather than at first-fetch. Empty CIDs
     * mean "not pinned" and are tolerated; the `resolveCid` empty-pin check
     * still rejects them per-artifact at fetch time.
     *
     * dag-pb CIDs must carry a manifest `*Sha256` digest, because the CID
     * itself cannot verify file content (see `verifyArtifactContent`). A
     * dag-pb entry without one would leave the artifact unverifiable, so it
     * is rejected here. Codecs other than raw and dag-pb are rejected
     * outright — the SDK has no verification story for them.
     *
     * A digest equal to {@link SHA256_OF_EMPTY_INPUT} is rejected for any
     * codec: it means the digest pipeline hashed a missing or empty file, and
     * no fetched artifact can ever match it.
     *
     * @throws {CircuitArtifactLoadFailed} If any pinned CID is malformed,
     *   uses an unsupported multihash algorithm or codec, is a dag-pb CID
     *   without a matching `*Sha256` digest, or carries a digest equal to the
     *   SHA-256 of empty input.
     */
    private validateManifestCIDs(): void {
        for (const [circuitName, entry] of this.circuitManifest.entries()) {
            for (const kind of ["wasm", "provingKey", "verificationKey"] as const) {
                const cid = entry[kind];
                if (cid === "") continue;
                let codec: number;
                try {
                    codec = parseCID(cid).codec;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new CircuitArtifactLoadFailed(
                        `Invalid CID for circuit "${circuitName}" artifact "${kind}": ${message}`,
                    );
                }
                if (codec !== CID_CODEC_RAW && codec !== CID_CODEC_DAG_PB) {
                    throw new CircuitArtifactLoadFailed(
                        `Unsupported CID codec 0x${codec.toString(16)} for circuit "${circuitName}" artifact "${kind}" (only raw and dag-pb are supported)`,
                    );
                }
                const sha = entry[`${kind}Sha256`];
                if (codec === CID_CODEC_DAG_PB && !SHA256_HEX_PATTERN.test(sha ?? "")) {
                    throw new CircuitArtifactLoadFailed(
                        `Circuit "${circuitName}" artifact "${kind}" uses a dag-pb CID, which requires a valid ${kind}Sha256 digest in the manifest to verify fetched content`,
                    );
                }
                if (
                    sha !== undefined &&
                    sha.toLowerCase().replace(/^0x/, "") === SHA256_OF_EMPTY_INPUT
                ) {
                    throw new CircuitArtifactLoadFailed(
                        `Circuit "${circuitName}" artifact "${kind}" has a ${kind}Sha256 equal to the SHA-256 of empty input — the digest was computed over a missing or empty file. Regenerate the manifest (pnpm generate:circuit-manifest)`,
                    );
                }
            }
        }
    }

    private async tryGateway(
        gateway: string,
        cid: string,
        circuitName: string,
        kind: ArtifactKind,
    ): Promise<GatewayAttempt> {
        const url = `${gateway}/${cid}`;
        this.logger?.debug("Fetching circuit artifact from IPFS", { circuitName, kind, url });

        let error: string;
        try {
            const bytes = await this.httpClient.getBinary(url);
            if (bytes.length > 0) {
                return { ok: true, bytes };
            }
            error = "empty response body";
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }

        this.logger?.warn("Gateway fetch failed, trying next", {
            gateway,
            circuitName,
            kind,
            error,
        });
        return { ok: false, error };
    }

    private async persistToCache(
        cid: string,
        bytes: Uint8Array,
        circuitName: string,
        kind: ArtifactKind,
    ): Promise<void> {
        try {
            await this.cacheStore.set(cid, bytes);
        } catch (cacheError) {
            const error = cacheError instanceof Error ? cacheError.message : String(cacheError);
            this.logger?.warn("Failed to persist circuit artifact to cache", {
                cid,
                circuitName,
                kind,
                error,
            });
        }
    }

    private validateGatewayUrls(urls: string[]): string[] {
        if (urls.length === 0) {
            throw new CircuitArtifactLoadFailed("ipfsGatewayUrls must not be empty");
        }
        const validated: string[] = [];
        for (const raw of urls) {
            const parsed = z.url().safeParse(raw);
            if (!parsed.success) {
                throw new CircuitArtifactLoadFailed(
                    `ipfsGatewayUrls contains invalid URL "${raw}": ${parsed.error.issues[0]!.message}`,
                );
            }
            // Strip trailing slash so `${gateway}/${cid}` never produces a double slash.
            validated.push(parsed.data.replace(/\/$/, ""));
        }
        return validated;
    }
}
