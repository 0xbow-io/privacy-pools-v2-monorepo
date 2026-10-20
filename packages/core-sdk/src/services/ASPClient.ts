import type {
    ASPClientConfig,
    ASPClientDependencies,
    Hash,
    IASPClient,
    IASPDataProvider,
    IASPRegistryInteractor,
    ILogger,
    IMerkleService,
    LabelStatus,
    MerkleProof,
    PublicKey,
} from "../internal.js";
import {
    ASP_ROOT_CACHE_TTL_MS,
    ASPClientConfigSchema,
    ASPLeavesRootMismatch,
    ASPUnavailable,
    ASSOCIATION_SET_MAX_DEPTH,
    InvalidASPClientConfig,
    LabelNotInSet,
    LeafNotFound,
} from "../internal.js";

/** Default implementation of {@link IASPClient}. */
export class ASPClient implements IASPClient {
    private readonly providers: IASPDataProvider[];
    private readonly merkleService: IMerkleService;
    private readonly aspRegistryInteractor: IASPRegistryInteractor;
    private readonly publicKey?: PublicKey;
    private readonly logger?: ILogger;
    /**
     * Cached on-chain `latestASPRoot` with a wall-clock TTL. The root is the
     * trust anchor for `getAssociationSetLeaves` verification; re-reading it
     * via `eth_call` on every leaves fetch would multiply RPC pressure under
     * burst. TTL is short enough that a stale anchor can't shadow new ASP
     * updates for long.
     */
    private cachedASPRoot: { value: Hash; fetchedAtMs: number } | null = null;

    /**
     * @throws {InvalidASPClientConfig} When the configuration is invalid.
     */
    constructor(config: ASPClientConfig, dependencies?: ASPClientDependencies) {
        const validated = ASPClientConfigSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidASPClientConfig(validated.error.issues[0].message);
        }

        this.providers = config.providers;
        this.merkleService = config.merkleService;
        this.aspRegistryInteractor = config.aspRegistryInteractor;
        this.publicKey = config.publicKey;
        this.logger = dependencies?.logger;
        this.logger?.debug("ASPClient initialized", { providerCount: this.providers.length });
    }

    /**
     * @inheritdoc IASPClient.getAssociationSetRoot
     * @throws {ASPUnavailable} When all providers fail.
     */
    async getAssociationSetRoot(): Promise<Hash> {
        return this.tryProviders((provider) => provider.getRoot());
    }

    /**
     * @inheritdoc IASPClient.getAssociationSetLeaves
     * @throws {ASPLeavesRootMismatch} When the LeanIMT root of the returned leaves
     *   does not match the on-chain `latestASPRoot`. Subclass of {@link ASPUnavailable}
     *   so `tryProviders` falls through to the next provider on mismatch.
     * @throws {ASPUnavailable} When all providers fail (fetch or verification).
     */
    async getAssociationSetLeaves(): Promise<Hash[]> {
        return this.tryProviders(async (provider) => {
            const leaves = await provider.getLeaves();
            // No legitimate association set is larger than its tree can hold. Reject on count
            // before computeRoot — the LeanIMT build is O(n) hashes, so an oversized array from a
            // hostile or broken provider would otherwise burn minutes of CPU and ~GB of memory on
            // the caller (a browser main thread). The shared LeavesSchema also caps leaves, but at
            // the deeper state-tree bound (16x looser); this is the tight cap for the one path that
            // ingests untrusted leaves over HTTP. Throwing lets tryProviders fall through to the
            // next provider, as with a root mismatch. Computed here, not at module load: the depth
            // constant arrives through the internal barrel and is not yet set when this file loads.
            const maxLeaves = 2 ** ASSOCIATION_SET_MAX_DEPTH;
            if (leaves.length > maxLeaves) {
                throw new ASPUnavailable(
                    `ASP returned ${leaves.length} leaves, exceeds the maximum of ${maxLeaves}`,
                );
            }
            const computedRoot = await this.merkleService.computeRoot(leaves);
            await this.assertLeavesMatchChainRoot(computedRoot, leaves.length);
            return leaves;
        });
    }

    /**
     * @inheritdoc IASPClient.getMerkleProof
     * @throws {LabelNotInSet} When the label is not found in the association set.
     * @throws {ASPUnavailable} When all providers fail to return leaves.
     */
    async getMerkleProof(labelHash: Hash): Promise<MerkleProof> {
        const leaves = await this.getAssociationSetLeaves();
        try {
            return await this.merkleService.generateMerkleProof(leaves, labelHash);
        } catch (error) {
            if (error instanceof LeafNotFound) {
                throw new LabelNotInSet(error.message);
            }
            throw error;
        }
    }

    /**
     * @inheritdoc IASPClient.getLabelStatus
     * @throws {ASPUnavailable} When all providers fail.
     */
    async getLabelStatus(label: Hash): Promise<LabelStatus> {
        return this.tryProviders((provider) => provider.getLabelStatus(label));
    }

    /**
     * @inheritdoc IASPClient.getASPPublicKey
     * @throws {ASPUnavailable} When all providers fail and no public key is configured.
     */
    async getASPPublicKey(): Promise<PublicKey> {
        if (this.publicKey) {
            return this.publicKey;
        }
        return this.tryProviders((provider) => provider.getASPPublicKey());
    }

    /**
     * Asserts the provider-computed leaves root matches the on-chain
     * `latestASPRoot`. Compares against the cached root first; on mismatch
     * forces one bypass-cache re-read of the on-chain root and retries
     * before declaring tampering, since the cache may be stale across a
     * legitimate on-chain root advance. Fresh on-chain root is
     * authoritative either way.
     *
     * @throws {ASPLeavesRootMismatch} When both cached and fresh on-chain
     *   roots disagree with the computed leaves root.
     */
    private async assertLeavesMatchChainRoot(computedRoot: Hash, leafCount: number): Promise<void> {
        const computed = computedRoot.toLowerCase();

        const cachedRoot = await this.getCachedASPRoot();
        if (computed === cachedRoot.toLowerCase()) return;

        const freshRoot = await this.refreshCachedASPRoot();
        if (computed === freshRoot.toLowerCase()) return;

        throw new ASPLeavesRootMismatch(
            `expected ${freshRoot}, got ${computedRoot} over ${leafCount} leaves`,
        );
    }

    private async tryProviders<T>(fn: (provider: IASPDataProvider) => Promise<T>): Promise<T> {
        const errors: Error[] = [];
        for (const provider of this.providers) {
            try {
                return await fn(provider);
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                this.logger?.warn("Provider failed, trying next", {
                    error: err.message,
                });
                errors.push(err);
            }
        }
        const messages = errors.map((e) => e.message).join("; ");
        throw new ASPUnavailable(`All providers failed: ${messages}`);
    }

    /**
     * Returns the on-chain `latestASPRoot`, served from a short TTL cache.
     * The cache exists because every `getAssociationSetLeaves` call now needs
     * the root for verification — without caching, that's an extra `eth_call`
     * per leaves fetch (and per-provider retry inside `tryProviders`).
     */
    private async getCachedASPRoot(): Promise<Hash> {
        const now = Date.now();
        if (
            this.cachedASPRoot !== null &&
            now - this.cachedASPRoot.fetchedAtMs < ASP_ROOT_CACHE_TTL_MS
        ) {
            return this.cachedASPRoot.value;
        }
        return this.refreshCachedASPRoot();
    }

    /**
     * Force-fetches `latestASPRoot` from the chain, bypassing the TTL cache,
     * and replaces the cached value. Used by the leaves-verification path
     * when a comparison against the cached root fails — the cache may be
     * stale across an on-chain root advance, so re-reading bypasses the
     * spurious-failure window before declaring tampering.
     */
    private async refreshCachedASPRoot(): Promise<Hash> {
        const value = await this.aspRegistryInteractor.getLatestASPRoot();
        this.cachedASPRoot = { value, fetchedAtMs: Date.now() };
        return value;
    }
}
