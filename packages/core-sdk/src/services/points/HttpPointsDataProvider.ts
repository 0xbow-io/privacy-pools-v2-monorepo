import type {
    Hex,
    HttpPointsDataProviderConfig,
    HttpPointsDataProviderDependencies,
    HTTPRequestOptions,
    IHashService,
    IHTTPClient,
    ILogger,
    IPointsDataProvider,
    PointsCohorts,
    PointsEpoch,
    PointsRateLeaves,
    PointsStats,
    PointsTvlSample,
    SpentNoteLeaves,
} from "../../internal.js";
import {
    HttpPointsDataProviderConfigSchema,
    HTTPResponseError,
    InvalidPointsDataProviderConfig,
    POINTS_FEED_MAX_PAGES,
    PointsCohortsPageSchema,
    PointsDataUnavailable,
    PointsEpochSchema,
    PointsEpochsPageSchema,
    PointsStatsResponseSchema,
    RateLeavesResponseSchema,
    rateTreeRoot,
    SpentNoteLeavesResponseSchema,
    spentNoteTreeRoot,
} from "../../internal.js";

const NO_STORE: HTTPRequestOptions = { cache: "no-store" };

/** HTTP-based implementation of {@link IPointsDataProvider}. */
export class HttpPointsDataProvider implements IPointsDataProvider {
    private readonly baseUrl: string;
    private readonly entrypointAddress: string;
    private readonly httpClient: IHTTPClient;
    private readonly hashService: IHashService;
    private readonly logger?: ILogger;

    /**
     * @throws {InvalidPointsDataProviderConfig} When the configuration is invalid.
     */
    constructor(
        config: HttpPointsDataProviderConfig,
        dependencies?: HttpPointsDataProviderDependencies,
    ) {
        const validated = HttpPointsDataProviderConfigSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidPointsDataProviderConfig(
                validated.error.issues[0]?.message ?? "invalid config",
            );
        }

        this.baseUrl = `${config.aspUrl.replace(/\/$/, "")}/${config.chainId}/public/points`;
        this.entrypointAddress = config.entrypointAddress;
        this.httpClient = config.httpClient;
        this.hashService = config.hashService;
        this.logger = dependencies?.logger;
        this.logger?.debug("HttpPointsDataProvider initialized", {
            baseUrl: this.baseUrl,
        });
    }

    /**
     * @inheritdoc IPointsDataProvider.getEpochs
     * @throws {PointsDataUnavailable} When a page fails, fails validation, the cursor does not
     *   advance, or the drain exceeds its page cap.
     */
    async getEpochs(): Promise<PointsEpoch[]> {
        const epochs: PointsEpoch[] = [];
        let cursor: string | undefined;
        // Drains until an empty page rather than a short one, so a smaller server page size can
        // never truncate the feed silently.
        for (let pageNumber = 1; ; pageNumber++) {
            const params: Record<string, string> = cursor === undefined ? {} : { sinceId: cursor };
            const page = await this.fetch(this.url("/epochs", params), (raw) =>
                PointsEpochsPageSchema.parse(raw),
            );
            if (page.epochs.length === 0) return epochs;
            epochs.push(...page.epochs);
            if (pageNumber >= POINTS_FEED_MAX_PAGES) {
                throw new PointsDataUnavailable(
                    `epochs drain incomplete after ${pageNumber} full pages`,
                );
            }
            if (cursor !== undefined && BigInt(page.lastSyncedId) <= BigInt(cursor)) {
                throw new PointsDataUnavailable("epochs cursor did not advance between pages");
            }
            cursor = page.lastSyncedId;
        }
    }

    /**
     * @inheritdoc IPointsDataProvider.getLatestEpoch
     * @throws {PointsDataUnavailable} When the request fails (other than a 404, which means no
     *   epoch yet) or the response fails validation.
     */
    async getLatestEpoch(): Promise<PointsEpoch | null> {
        return this.fetch(this.url("/epochs/latest"), (raw) => PointsEpochSchema.parse(raw), {
            nullOnNotFound: true,
        });
    }

    /**
     * @inheritdoc IPointsDataProvider.getSpentNoteLeaves
     * @throws {PointsDataUnavailable} When the request fails, the response fails validation, it is
     *   for a different epoch than asked, or its leaves do not recompute to its `spentNoteRoot`.
     */
    async getSpentNoteLeaves(epochNumber: Hex): Promise<SpentNoteLeaves> {
        const epoch = this.epochPathSegment(epochNumber);
        const result = await this.fetch(this.url(`/epochs/${epoch}/spent-note-leaves`), (raw) =>
            SpentNoteLeavesResponseSchema.parse(raw),
        );
        if (BigInt(result.epochNumber) !== BigInt(epochNumber)) {
            throw new PointsDataUnavailable("spent-note leaves were served for a different epoch");
        }
        if (spentNoteTreeRoot(result.leaves, this.hashService) !== BigInt(result.spentNoteRoot)) {
            throw new PointsDataUnavailable("spent-note leaves do not recompute to spentNoteRoot");
        }
        return result;
    }

    /**
     * @inheritdoc IPointsDataProvider.getRateLeaves
     * @throws {PointsDataUnavailable} When the request fails (a 404 means the epoch does not exist
     *   or predates the rate tree), the response fails validation, it is for a different epoch, or
     *   its leaves do not recompute to its `rateRoot`.
     */
    async getRateLeaves(epochNumber: Hex): Promise<PointsRateLeaves> {
        const epoch = this.epochPathSegment(epochNumber);
        const result = await this.fetch(this.url(`/epochs/${epoch}/rate-leaves`), (raw) =>
            RateLeavesResponseSchema.parse(raw),
        );
        if (BigInt(result.epochNumber) !== BigInt(epochNumber)) {
            throw new PointsDataUnavailable("rate leaves were served for a different epoch");
        }
        if (rateTreeRoot(result.leaves, this.hashService) !== BigInt(result.rateRoot)) {
            throw new PointsDataUnavailable("rate leaves do not recompute to rateRoot");
        }
        return result;
    }

    /**
     * @inheritdoc IPointsDataProvider.getCohorts
     * @throws {PointsDataUnavailable} When a page fails, fails validation, the series cursor does
     *   not advance, or the drain exceeds its page cap.
     */
    async getCohorts(): Promise<PointsCohorts> {
        const series: PointsTvlSample[] = [];
        let since: string | undefined;
        for (let pageNumber = 1; ; pageNumber++) {
            const params: Record<string, string> = since === undefined ? {} : { since };
            const page = await this.fetch(this.url("/cohorts", params), (raw) =>
                PointsCohortsPageSchema.parse(raw),
            );
            series.push(...page.series);
            if (!page.seriesHasMore) {
                const { seriesHasMore: _hasMore, seriesNextSince: _next, ...rest } = page;
                return { ...rest, series };
            }
            if (pageNumber >= POINTS_FEED_MAX_PAGES) {
                throw new PointsDataUnavailable(
                    `cohort series drain incomplete after ${pageNumber} pages`,
                );
            }
            if (page.seriesNextSince === since) {
                throw new PointsDataUnavailable(
                    "cohort series cursor did not advance between pages",
                );
            }
            since = page.seriesNextSince ?? undefined;
        }
    }

    /**
     * @inheritdoc IPointsDataProvider.getStats
     * @throws {PointsDataUnavailable} When the request fails or the response fails validation.
     */
    async getStats(): Promise<PointsStats> {
        return this.fetch(this.url("/stats"), (raw) => PointsStatsResponseSchema.parse(raw));
    }

    private epochPathSegment(epochNumber: Hex): string {
        if (!/^0x[0-9a-fA-F]+$/.test(epochNumber)) {
            throw new PointsDataUnavailable("epochNumber must be a 0x-prefixed hex value");
        }
        return BigInt(epochNumber).toString();
    }

    private url(path: string, params: Record<string, string> = {}): string {
        const search = new URLSearchParams(params);
        search.set("entrypoint", this.entrypointAddress);
        const query = search.toString();
        return `${this.baseUrl}${path}${query ? `?${query}` : ""}`;
    }

    private async fetch<T>(url: string, parse: (raw: unknown) => T): Promise<T>;
    private async fetch<T>(
        url: string,
        parse: (raw: unknown) => T,
        options: { nullOnNotFound: true },
    ): Promise<T | null>;
    private async fetch<T>(
        url: string,
        parse: (raw: unknown) => T,
        options?: { nullOnNotFound: true },
    ): Promise<T | null> {
        let raw: unknown;
        try {
            raw = await this.httpClient.get<unknown>(url, NO_STORE);
        } catch (error) {
            if (
                options?.nullOnNotFound &&
                error instanceof HTTPResponseError &&
                error.status === 404
            ) {
                return null;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new PointsDataUnavailable(message);
        }
        try {
            return parse(raw);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new PointsDataUnavailable(`response failed validation: ${message}`);
        }
    }
}
