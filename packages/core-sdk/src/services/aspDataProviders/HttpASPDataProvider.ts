import { bytesToHex } from "@noble/ciphers/utils.js";

import type {
    Address,
    EventSnapshot,
    Hash,
    Hex,
    HttpASPDataProviderConfig,
    HttpASPDataProviderDependencies,
    HTTPRequestOptions,
    IASPDataProvider,
    IHTTPClient,
    ILogger,
    IYieldFeedProvider,
    LabelStatus,
    NoteEvent,
    PublicKey,
    SnapshotArrayName,
    SnapshotRowIssue,
    YieldDepositFact,
    YieldRateSeries,
} from "../../internal.js";
import {
    ASPPublicKeyResponseSchema,
    ASPUnavailable,
    bigintToHex,
    HttpASPDataProviderConfigSchema,
    HTTPResponseError,
    InvalidASPClientConfig,
    LabelStatusSchema,
    NoteEventsResponseSchema,
    parseEventSnapshotTolerant,
    YIELD_FEED_MAX_PAGES,
    YIELD_FEED_PAGE_SIZE,
    YieldDepositsPageSchema,
    YieldRateHistoryPageSchema,
} from "../../internal.js";

// ASP reads that reflect mutable on-chain state pass this so a browser HTTP cache cannot serve a
// stale response. The ASP public key (getASPPublicKey) is effectively static and stays cacheable.
const NO_STORE: HTTPRequestOptions = { cache: "no-store" };

/** HTTP-based implementation of {@link IASPDataProvider} and {@link IYieldFeedProvider}. */
export class HttpASPDataProvider implements IASPDataProvider, IYieldFeedProvider {
    private readonly aspUrl: string;
    private readonly chainId: number;
    private readonly entrypointAddress: string;
    private readonly httpClient: IHTTPClient;
    private readonly logger?: ILogger;

    /**
     * @throws {InvalidASPClientConfig} When the configuration is invalid.
     */
    constructor(config: HttpASPDataProviderConfig, dependencies?: HttpASPDataProviderDependencies) {
        const validated = HttpASPDataProviderConfigSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidASPClientConfig(validated.error.issues[0].message);
        }

        this.aspUrl = config.aspUrl.replace(/\/$/, "");
        this.chainId = config.chainId;
        this.entrypointAddress = config.entrypointAddress;
        this.httpClient = config.httpClient;
        this.logger = dependencies?.logger;
        this.logger?.debug("HttpASPDataProvider initialized", { aspUrl: this.aspUrl });
    }

    /**
     * @inheritdoc IASPDataProvider.getRoot
     * @throws {ASPUnavailable} When the HTTP request fails.
     */
    async getRoot(): Promise<Hash> {
        try {
            const data = await this.httpClient.get<{ root: string }>(
                `${this.aspUrl}/association-set/root?chainId=${this.chainId}&entrypoint=${this.entrypointAddress}`,
                NO_STORE,
            );
            return bigintToHex(BigInt(data.root));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new ASPUnavailable(message);
        }
    }

    /**
     * @inheritdoc IASPDataProvider.getLeaves
     * @throws {ASPUnavailable} When the HTTP request fails.
     */
    async getLeaves(): Promise<Hash[]> {
        try {
            const data = await this.httpClient.get<{ leaves: string[] }>(
                `${this.aspUrl}/association-set/leaves?chainId=${this.chainId}&entrypoint=${this.entrypointAddress}`,
                NO_STORE,
            );
            return data.leaves.map((leaf) => bigintToHex(BigInt(leaf)));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new ASPUnavailable(message);
        }
    }

    /**
     * @inheritdoc IASPDataProvider.getLabelStatus
     * @throws {ASPUnavailable} When the HTTP request fails.
     */
    async getLabelStatus(label: Hash): Promise<LabelStatus> {
        const decimalLabel = BigInt(label).toString();
        try {
            const raw = await this.httpClient.get<unknown>(
                `${this.aspUrl}/labels/${decimalLabel}/status`,
                NO_STORE,
            );
            return LabelStatusSchema.parse(raw);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new ASPUnavailable(message);
        }
    }

    /**
     * @inheritdoc IASPDataProvider.getASPPublicKey
     * @throws {ASPUnavailable} When the HTTP request fails.
     */
    async getASPPublicKey(): Promise<PublicKey> {
        try {
            const raw = await this.httpClient.get<unknown>(`${this.aspUrl}/public-key`);
            const parsed = ASPPublicKeyResponseSchema.parse(raw);
            return ("0x" + bytesToHex(parsed.publicKey)) as PublicKey;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new ASPUnavailable(message);
        }
    }

    /**
     * @inheritdoc IASPDataProvider.getEventSnapshot
     * @throws {ASPUnavailable} When the HTTP request fails or the payload envelope
     *   fails validation.
     */
    async getEventSnapshot(): Promise<EventSnapshot> {
        try {
            const raw = await this.httpClient.get<unknown>(
                `${this.aspUrl}/${this.chainId}/public/event-snapshot/payload?entrypoint=${this.entrypointAddress}`,
                NO_STORE,
            );

            // Rows are validated one at a time: one malformed row used to reject the
            // whole payload, and the consumers answer a rejected snapshot by scanning
            // chain history instead — so a single drifted field (a column that turns
            // nullable on one ASP version) cost every client its snapshot. Dropped rows
            // are reported on `snapshot.drops` so callers shrink the range they treat
            // as covered rather than silently trust a thinner payload.
            const { snapshot, issues, degraded } = parseEventSnapshotTolerant(raw);
            this.logSnapshotRowIssues(snapshot, issues, degraded);
            return snapshot;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new ASPUnavailable(message);
        }
    }

    /**
     * @inheritdoc IASPDataProvider.getNoteEvents
     * @throws {ASPUnavailable} When the HTTP request fails or the response fails validation.
     */
    async getNoteEvents(
        fromBlock?: Hex,
        toBlock?: Hex,
    ): Promise<{ events: NoteEvent[]; lastSyncedBlock: Hex }> {
        try {
            // entrypoint scopes the stream to one pool: the ASP can host
            // several pools per chain, and events from an abandoned deployment
            // must not reach note discovery.
            const params = new URLSearchParams({ entrypoint: this.entrypointAddress });
            if (fromBlock) params.set("since", BigInt(fromBlock).toString());
            if (toBlock) params.set("until", BigInt(toBlock).toString());
            const url = `${this.aspUrl}/${this.chainId}/public/note-events?${params.toString()}`;

            const raw = await this.httpClient.get<unknown>(url, NO_STORE);

            // The ASP occasionally returns events with an empty `encryptedPayload`
            // (e.g. "0x"), which would fail `HexSchema` and reject the whole batch.
            // Such events carry nothing to decrypt, so drop them and surface a
            // single aggregated warning instead of failing the entire fetch.
            const { events, droppedCount } = this.dropEmptyPayloadEvents(raw);
            if (droppedCount > 0) {
                this.logger?.warn(
                    `Dropped ${droppedCount} ASP note event(s) with an empty encryptedPayload`,
                );
            }

            const validatedData = NoteEventsResponseSchema.parse(events);
            return validatedData;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new ASPUnavailable(message);
        }
    }

    /**
     * @inheritdoc IYieldFeedProvider.getYieldRateSeries
     * @throws {ASPUnavailable} When a page fails (other than a first-page 404), the drain cannot
     *   complete, the payload fails validation, the ASP serves a different share than asked, or
     *   the rows carry no decimals.
     */
    async getYieldRateSeries(share: Address): Promise<YieldRateSeries | null> {
        const shareKey = share.toLowerCase();
        // FULL FEED, EVERY PAGE, ALWAYS. The request names only the share (public configuration)
        // and the server's own cursor from the previous page. It must never carry a time, a
        // block, or anything derived from the wallet's notes, and the drain must never stop early
        // because "the wallet's oldest note is covered": the ASP sees the request stream, and any
        // of those would make it a function of which notes this client holds. A later
        // optimisation that adds a `since` here re-creates exactly the leak this design exists
        // to avoid.
        const pages = await this.drainYieldFeed(
            (sinceId) => {
                const params = new URLSearchParams({ asset: shareKey });
                if (sinceId !== undefined) params.set("sinceId", sinceId);
                return `${this.aspUrl}/${this.chainId}/public/ppusdc-rate-history?${params.toString()}`;
            },
            (raw) => YieldRateHistoryPageSchema.parse(raw),
            (page) => page.snapshots,
            (page) => page.lastSyncedId,
        );
        if (pages === null) return null;

        let shareDecimals: number | null = null;
        let assetDecimals: number | null = null;
        const observations: YieldRateSeries["observations"][number][] = [];
        for (const page of pages) {
            if (page.ppUsdcAddress.toLowerCase() !== shareKey) {
                throw new ASPUnavailable("rate history was served for a different share");
            }
            for (const row of page.snapshots) {
                if (row.shareDecimals !== null) {
                    if (shareDecimals !== null && shareDecimals !== row.shareDecimals) {
                        throw new ASPUnavailable("rate history rows disagree on shareDecimals");
                    }
                    shareDecimals = row.shareDecimals;
                }
                if (row.assetDecimals !== null) {
                    if (assetDecimals !== null && assetDecimals !== row.assetDecimals) {
                        throw new ASPUnavailable("rate history rows disagree on assetDecimals");
                    }
                    assetDecimals = row.assetDecimals;
                }
                observations.push({
                    timestamp: row.observationTimestamp,
                    exchangeRate: row.exchangeRate,
                    block: row.observationBlock,
                });
            }
        }
        if (observations.length > 0 && (shareDecimals === null || assetDecimals === null)) {
            throw new ASPUnavailable("rate history carries no decimals");
        }
        observations.sort((a, b) => a.timestamp - b.timestamp);
        return {
            share: shareKey as Address,
            shareDecimals: shareDecimals ?? 0,
            assetDecimals: assetDecimals ?? 0,
            observations,
        };
    }

    /**
     * @inheritdoc IYieldFeedProvider.getYieldDepositFacts
     * @throws {ASPUnavailable} When a page fails (other than a first-page 404), the drain cannot
     *   complete, or the payload fails validation.
     */
    async getYieldDepositFacts(share: Address): Promise<readonly YieldDepositFact[] | null> {
        const shareKey = share.toLowerCase();
        // FULL FEED, EVERY PAGE, ALWAYS. The feed has no server-side filter and this request
        // carries none: no asset, no commitment, no time, only the server's own page cursor.
        // Narrowing happens locally, after the bytes have arrived, where the ASP cannot see it.
        // See getYieldRateSeries for why a "smaller" request here is a privacy regression.
        const pages = await this.drainYieldFeed(
            (sinceId) => {
                const params = new URLSearchParams();
                if (sinceId !== undefined) params.set("sinceId", sinceId);
                const query = params.toString();
                return `${this.aspUrl}/${this.chainId}/public/yield-deposits${query ? `?${query}` : ""}`;
            },
            (raw) => YieldDepositsPageSchema.parse(raw),
            (page) => page.deposits,
            (page) => page.lastSyncedId,
        );
        if (pages === null) return null;

        const facts: YieldDepositFact[] = [];
        let dropped = 0;
        for (const page of pages) {
            for (const row of page.deposits) {
                if (
                    row.grossUnderlying === null ||
                    row.noteShares === null ||
                    row.totalSharesMinted === null
                ) {
                    // A fact the indexer could not correlate carries no basis. Dropping it
                    // makes that deposit `deposit-fact-missing` downstream, which is the honest
                    // answer; pricing it off the rate series would not be.
                    dropped++;
                    continue;
                }
                if (row.asset.toLowerCase() !== shareKey) continue;
                facts.push({
                    outputCommitment: row.outputCommitment,
                    asset: row.asset,
                    txHash: row.txHash,
                    grossUnderlying: row.grossUnderlying,
                    noteShares: row.noteShares,
                    totalSharesMinted: row.totalSharesMinted,
                    vettingFeeShares:
                        row.vettingFeeShares ?? row.totalSharesMinted - row.noteShares,
                    blockTimestamp: row.blockTimestamp,
                });
            }
        }
        if (dropped > 0) {
            this.logger?.warn(`Dropped ${dropped} yield-deposit fact(s) with no value columns`);
        }
        return facts;
    }

    /**
     * Drains one public yield feed from its first page to its last.
     *
     * Protocol (asp-v2 `PublicService.YIELD_FEED_PAGE_SIZE`): a page holds at most
     * {@link YIELD_FEED_PAGE_SIZE} rows and `lastSyncedId` is the id of the last row returned.
     * A page with fewer rows means caught up; a page with MORE can only be the pre-pagination
     * protocol, which returns everything at once, so it is complete too. Exactly the page size
     * is the one ambiguous case and asks for another page. A cursor that does not advance, or
     * more than {@link YIELD_FEED_MAX_PAGES} pages, is an incomplete drain and throws: a partial
     * feed must never be handed on as a thin one.
     *
     * @returns Every page in order, or `null` when the first page answers 404 (the feed is not
     *   enabled on this chain). A 404 on a later page is a mid-drain contradiction and throws.
     * @throws {ASPUnavailable} On any request failure other than a first-page 404, on a payload
     *   that fails validation, and on an incomplete drain.
     */
    private async drainYieldFeed<TPage>(
        urlFor: (sinceId: string | undefined) => string,
        parsePage: (raw: unknown) => TPage,
        rowsOf: (page: TPage) => readonly unknown[],
        cursorOf: (page: TPage) => string,
    ): Promise<TPage[] | null> {
        const pages: TPage[] = [];
        let cursor: string | undefined;
        for (let pageNumber = 1; ; pageNumber++) {
            let raw: unknown;
            try {
                raw = await this.httpClient.get<unknown>(urlFor(cursor), NO_STORE);
            } catch (error) {
                if (
                    cursor === undefined &&
                    error instanceof HTTPResponseError &&
                    error.status === 404
                ) {
                    return null;
                }
                const message = error instanceof Error ? error.message : String(error);
                throw new ASPUnavailable(message);
            }
            let page: TPage;
            try {
                page = parsePage(raw);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new ASPUnavailable(`yield feed page failed validation: ${message}`);
            }
            pages.push(page);
            if (rowsOf(page).length !== YIELD_FEED_PAGE_SIZE) return pages;
            if (pageNumber >= YIELD_FEED_MAX_PAGES) {
                throw new ASPUnavailable(
                    `yield feed drain incomplete after ${pageNumber} full pages`,
                );
            }
            const next = cursorOf(page);
            if (!cursorAdvances(next, cursor)) {
                throw new ASPUnavailable("yield feed cursor did not advance between pages");
            }
            cursor = next;
        }
    }

    /**
     * Emits one aggregated warning when per-row validation dropped or degraded rows.
     *
     * Degraded rows are reported too, not just drops: they cost the caller no state
     * and no coverage, but they are the earliest visible sign that the ASP's payload
     * has drifted from the schema — silence there means finding out later, from a
     * `null` somewhere downstream.
     *
     * Counts, array names, field paths and Zod's shape-only messages — never a
     * field value. Snapshot rows carry commitments, nullifiers, labels and
     * addresses, and where SDK logs end up is the integrator's decision, so ASP
     * data must not ride along into a log sink to make a parse error readable.
     */
    private logSnapshotRowIssues(
        snapshot: EventSnapshot,
        issues: SnapshotRowIssue[],
        degraded: Partial<Record<SnapshotArrayName, number>>,
    ): void {
        const totalDropped = Object.values(snapshot.drops ?? {}).reduce(
            (sum, entry) => sum + entry.dropped,
            0,
        );
        const totalDegraded = Object.values(degraded).reduce((sum, count) => sum + count, 0);
        if (totalDropped === 0 && totalDegraded === 0) return;

        this.logger?.warn(
            `ASP event snapshot: dropped ${totalDropped} row(s), degraded ${totalDegraded}`,
            {
                drops: snapshot.drops,
                degraded,
                snapshotBlockNumber: snapshot.snapshotBlockNumber,
                issues: issues.map(
                    (issue) =>
                        `${issue.kind} ${issue.array}[${issue.index}].${issue.field}: ${issue.message}`,
                ),
            },
        );
    }

    /**
     * Removes note events whose `encryptedPayload` is empty (`""` or `"0x"`)
     * from the raw ASP response, returning the cleaned payload plus the number
     * dropped. Non-object/non-array shapes pass through untouched so the schema
     * still reports genuinely malformed responses.
     */
    private dropEmptyPayloadEvents(raw: unknown): { events: unknown; droppedCount: number } {
        if (typeof raw !== "object" || raw === null || !("events" in raw)) {
            return { events: raw, droppedCount: 0 };
        }
        const rawEvents = (raw as { events?: unknown }).events;
        if (!Array.isArray(rawEvents)) {
            return { events: raw, droppedCount: 0 };
        }

        const kept = rawEvents.filter((event) => {
            const payload = (event as { encryptedPayload?: unknown } | null)?.encryptedPayload;
            return payload !== undefined && payload !== null && payload !== "" && payload !== "0x";
        });

        return {
            events: { ...(raw as object), events: kept },
            droppedCount: rawEvents.length - kept.length,
        };
    }
}

/**
 * Did the feed cursor move strictly forward? Feed ids are decimal bigserials, so compare as
 * integers when both sides are; a non-numeric cursor only has to differ.
 */
function cursorAdvances(next: string, previous: string | undefined): boolean {
    if (previous === undefined) return next.length > 0;
    if (/^\d+$/.test(next) && /^\d+$/.test(previous)) return BigInt(next) > BigInt(previous);
    return next.length > 0 && next !== previous;
}
