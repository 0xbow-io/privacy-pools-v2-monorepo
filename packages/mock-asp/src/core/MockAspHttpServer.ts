import http from "node:http";
import type { AddressInfo } from "node:net";

import { bytesToHex, randomBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import type { Hex, LabelStatus } from "@privacy-pools-v2/core-sdk";
import { bigintToHex } from "@privacy-pools-v2/core-sdk";

import type {
    ActiveFault,
    AspChainEventSource,
    AspEndpoint,
    AspRootPublisher,
    ChainScope,
    FaultMode,
    FaultSpec,
    WireEventSnapshot,
    WireNoteEvent,
} from "../internal.js";
import { AspState, validateFaultSpec } from "../internal.js";

/** Non-empty placeholder — registries only check the content id is non-empty, never its content. */
const PLACEHOLDER_CID = "0x6d6f636b" as Hex; // "mock"

const LABEL_STATUSES = ["pending", "approved", "rejected", "poi_required", "unknown"] as const;
const ZERO_WORD = ("0x" + "00".repeat(32)) as Hex;

export interface MockAspHttpServerConfig {
    scope: ChainScope;
    publisher: AspRootPublisher;
    /** Serves `note-events` / `event-snapshot`; an endpoint the source does not implement answers `501`. */
    eventSource?: AspChainEventSource;
    /** X25519 public key served at `/public-key`; a fresh random one when omitted. */
    publicKey?: Hex;
    /** Seed the served root from `publisher.readLatestRoot()` on startup (dev tooling only). */
    seedPublishedRoot?: boolean;
    /** Defaults to `127.0.0.1`. */
    host?: string;
    /** Defaults to `0` (ephemeral), so tests never collide. */
    port?: number;
    /** `Access-Control-Allow-Origin` value; defaults to `*`. */
    allowOrigin?: string;
    log?: (line: string) => void;
}

/** One handled request, kept for assertions (e.g. which cache headers the client sent). */
export interface RequestLogEntry {
    method: string;
    path: string;
    query: string;
    /** `0` when the connection was destroyed without a response. */
    status: number;
    endpoint: AspEndpoint | "admin" | "unmatched";
    cacheControl?: string;
}

export interface ApprovalResult {
    leaf: Hex;
    root: Hex;
    /** Whether the root was published to the registry. */
    published: boolean;
    txId?: string;
}

export interface MockAspState {
    scope: ChainScope;
    /** Decimal strings, in tree order. */
    leaves: string[];
    /** Decimal string of the root the registry holds. */
    publishedRoot: string;
    faults: ActiveFault[];
    labelStatusOverrides: Record<string, LabelStatus>;
    requestCount: number;
}

/** Thrown for a malformed request; surfaces as HTTP 400. */
class BadRequestError extends Error {}
/** Thrown when an admin request names an unknown label; surfaces as HTTP 404. */
export class UnknownLabelError extends Error {
    constructor(label: string) {
        super(`label ${label} was never approved`);
        this.name = "UnknownLabelError";
    }
}

/**
 * A chain-agnostic Association Set Provider over plain HTTP. Implements exactly the read contract
 * core-sdk's `HttpASPDataProvider` consumes, plus an `/admin` API for approving/revoking labels
 * and injecting faults. Everything chain-specific is behind {@link AspRootPublisher} and
 * {@link AspChainEventSource}.
 *
 * Wire summary (all `GET`, JSON):
 * `/health`, `/association-set/root`, `/association-set/leaves`, `/labels/{decimalLeaf}/status`,
 * `/public-key`, `/{chainId}/public/note-events`, `/{chainId}/public/event-snapshot/payload`.
 * Admin: `POST /admin/approve-label|revoke-label|label-status|faults|reset`,
 * `DELETE /admin/faults`, `GET /admin/state` (never faulted, never scope-checked).
 */
export class MockAspHttpServer {
    readonly state: AspState;
    private readonly config: MockAspHttpServerConfig;
    private readonly publicKey: Hex;
    private readonly server: http.Server;
    private readonly faults: ActiveFault[] = [];
    private readonly hanging = new Set<http.ServerResponse>();
    private readonly requestLog: RequestLogEntry[] = [];
    private queue: Promise<unknown> = Promise.resolve();
    private baseUrl = "";

    /**
     * Builds the state, optionally seeds the published root, and starts listening.
     *
     * @throws {Error} When the port cannot be bound.
     */
    static async start(config: MockAspHttpServerConfig): Promise<MockAspHttpServer> {
        const state = await AspState.create();
        if (config.seedPublishedRoot) {
            const latest = await config.publisher.readLatestRoot?.();
            if (latest !== null && latest !== undefined) state.seedPublishedRoot(latest);
        }
        const instance = new MockAspHttpServer(config, state);
        await instance.listen();
        return instance;
    }

    constructor(config: MockAspHttpServerConfig, state: AspState) {
        this.config = config;
        this.state = state;
        this.publicKey =
            config.publicKey ?? (("0x" + bytesToHex(x25519.getPublicKey(randomBytes(32)))) as Hex);
        this.server = http.createServer((req, res) => {
            void this.handle(req, res).catch((error: unknown) => {
                this.log(`unhandled error: ${error instanceof Error ? error.message : String(error)}`);
                if (!res.headersSent) this.sendJson(res, 500, { error: "internal_error" });
                else res.end();
            });
        });
    }

    get url(): string {
        return this.baseUrl;
    }

    get port(): number {
        return Number(new URL(this.baseUrl).port);
    }

    get publicKeyHex(): Hex {
        return this.publicKey;
    }

    /**
     * Adds a label's leaf to the association set and (by default) publishes the new root.
     *
     * @param label - The deposit label, as returned by `prepareDeposit`.
     * @param options.pushRoot - `false` approves in the ASP without publishing, leaving the served
     *   root behind the served leaves ("approved but root not pushed yet").
     */
    approveLabel(label: Hex, options?: { pushRoot?: boolean }): Promise<ApprovalResult> {
        return this.serialize(async () => {
            const plan = await this.state.planApprove(label);
            const push = options?.pushRoot ?? true;
            let txId: string | undefined;
            let published = false;
            if (push) {
                if (plan.root !== this.state.publishedRoot) {
                    ({ txId } = await this.config.publisher.publishRoot(plan.root, PLACEHOLDER_CID));
                }
                published = true;
            }
            this.state.commit(plan, published);
            return { leaf: plan.leaf, root: bigintToHex(plan.root), published, txId };
        });
    }

    /**
     * Removes a label's leaf, publishes the shrunken root, and marks the label `rejected`.
     * Revoking the only remaining leaf publishes root `0`, which a registry may refuse.
     *
     * @throws {UnknownLabelError} When the label was never approved.
     */
    revokeLabel(label: Hex): Promise<ApprovalResult> {
        return this.serialize(async () => {
            const plan = await this.state.planRevoke(label);
            if (!plan) throw new UnknownLabelError(label);
            const { txId } = await this.config.publisher.publishRoot(plan.root, PLACEHOLDER_CID);
            this.state.commit(plan, true);
            this.state.setStatusOverride(plan.leaf, { status: "rejected" });
            return { leaf: plan.leaf, root: bigintToHex(plan.root), published: true, txId };
        });
    }

    /** Forces the status served for a label (or leaf) regardless of set membership. */
    setLabelStatus(target: { label: Hex } | { leaf: Hex }, status: LabelStatus): void {
        const leaf = "label" in target ? this.state.leafForLabel(target.label) : target.leaf;
        this.state.setStatusOverride(leaf, status);
    }

    /**
     * @returns The registered fault.
     * @throws {Error} When the spec is invalid.
     */
    addFault(spec: FaultSpec): ActiveFault {
        const problem = validateFaultSpec(spec);
        if (problem) throw new BadRequestError(problem);
        const fault: ActiveFault = {
            endpoint: spec.endpoint ?? "*",
            mode: spec.mode,
            remaining: spec.count ?? null,
        };
        this.faults.push(fault);
        return fault;
    }

    clearFaults(): number {
        const cleared = this.faults.length;
        this.faults.length = 0;
        this.releaseHanging();
        return cleared;
    }

    /** Clears faults and label-status overrides. Leaves stay: the set is append-only vs. the chain. */
    reset(): void {
        this.clearFaults();
        this.state.clearOverrides();
    }

    getState(): MockAspState {
        return {
            scope: this.config.scope,
            leaves: this.state.leaves.map((leaf) => BigInt(leaf).toString()),
            publishedRoot: this.state.publishedRoot.toString(),
            faults: this.faults.map((fault) => ({ ...fault })),
            labelStatusOverrides: this.state.getStatusOverrides(),
            requestCount: this.requestLog.length,
        };
    }

    getRequestLog(): readonly RequestLogEntry[] {
        return this.requestLog;
    }

    clearRequestLog(): void {
        this.requestLog.length = 0;
    }

    async stop(): Promise<void> {
        this.releaseHanging();
        this.server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
            this.server.close((error) => (error ? reject(error) : resolve()));
        });
    }

    private listen(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(this.config.port ?? 0, this.config.host ?? "127.0.0.1", () => {
                this.server.off("error", reject);
                const { address, port } = this.server.address() as AddressInfo;
                this.baseUrl = `http://${address}:${port}`;
                this.log(`listening on ${this.baseUrl}`);
                resolve();
            });
        });
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", "http://mock-asp.local");
        const method = req.method ?? "GET";
        this.log(`${method} ${url.pathname}${url.search}`);

        // CORS on every response — including errors and 501s. A failed preflight would make an
        // HTTP error look like a network failure to a browser client.
        res.setHeader("Access-Control-Allow-Origin", this.config.allowOrigin ?? "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (method === "OPTIONS") {
            this.record(req, url, 204, "unmatched");
            res.writeHead(204);
            res.end();
            return;
        }
        if (url.pathname.startsWith("/admin/")) {
            await this.handleAdmin(req, res, url);
            return;
        }

        const route = this.matchRoute(method, url.pathname);
        if (!route) {
            this.record(req, url, 404, "unmatched");
            this.sendJson(res, 404, { error: "not_found" });
            return;
        }

        const scopeError = this.checkScope(url, route.pathChainId);
        if (scopeError) {
            this.record(req, url, scopeError.status, route.endpoint);
            this.sendJson(res, scopeError.status, scopeError.body);
            return;
        }

        const fault = this.takeFault(route.endpoint);
        if (fault && this.applyGenericFault(req, res, url, route.endpoint, fault.mode)) return;

        try {
            const payload = await route.run(fault?.mode, url);
            if (payload === NOT_IMPLEMENTED) {
                this.record(req, url, 501, route.endpoint);
                this.sendJson(res, 501, {
                    error: "not_implemented",
                    message: "This mock ASP does not serve this endpoint",
                });
                return;
            }
            this.record(req, url, 200, route.endpoint);
            this.sendJson(res, 200, payload);
        } catch (error) {
            if (error instanceof BadRequestError) {
                this.record(req, url, 400, route.endpoint);
                this.sendJson(res, 400, { error: "bad_request", message: error.message });
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.record(req, url, 500, route.endpoint);
            this.sendJson(res, 500, { error: "upstream_failed", message });
        }
    }

    private matchRoute(method: string, pathname: string): Route | undefined {
        if (method !== "GET") return undefined;
        if (pathname === "/health") {
            return { endpoint: "health", run: () => Promise.resolve({ status: "ok" }) };
        }
        if (pathname === "/association-set/root") {
            return {
                endpoint: "root",
                run: (mode) =>
                    Promise.resolve({
                        root: (mode === "stale-root"
                            ? this.state.previousPublishedRoot
                            : this.state.publishedRoot
                        ).toString(),
                    }),
            };
        }
        if (pathname === "/association-set/leaves") {
            return {
                endpoint: "leaves",
                run: (mode) => {
                    const leaves = this.state.leaves.map((leaf) => BigInt(leaf));
                    if (mode === "bad-leaves") {
                        // Any perturbation makes the tree root differ from the served root.
                        const last = leaves.pop();
                        leaves.push(last === undefined ? 1n : last ^ 1n);
                    }
                    return Promise.resolve({ leaves: leaves.map((leaf) => leaf.toString()) });
                },
            };
        }
        const label = pathname.match(/^\/labels\/([0-9]+)\/status$/);
        if (label) {
            return {
                endpoint: "label-status",
                run: () => Promise.resolve(this.state.statusOf(label[1] ?? "0")),
            };
        }
        if (pathname === "/public-key") {
            return {
                endpoint: "public-key",
                run: () => Promise.resolve({ publicKey: this.publicKey }),
            };
        }
        const noteEvents = pathname.match(/^\/(\d+)\/public\/note-events$/);
        if (noteEvents) {
            return {
                endpoint: "note-events",
                pathChainId: noteEvents[1],
                run: (mode, requestUrl) => this.serveNoteEvents(requestUrl, mode),
            };
        }
        const snapshot = pathname.match(/^\/(\d+)\/public\/event-snapshot\/payload$/);
        if (snapshot) {
            return {
                endpoint: "event-snapshot",
                pathChainId: snapshot[1],
                run: (mode) => this.serveSnapshot(mode),
            };
        }
        return undefined;
    }

    private async serveNoteEvents(url: URL, mode?: FaultMode): Promise<unknown> {
        const source = this.config.eventSource;
        if (!source?.getNoteEvents) return NOT_IMPLEMENTED;
        const page = await source.getNoteEvents({
            since: parseBlockParam(url.searchParams.get("since")),
            until: parseBlockParam(url.searchParams.get("until")),
        });
        let events: WireNoteEvent[] = [...page.events];
        if (mode === "empty-payload-events") {
            events = [
                ...events,
                {
                    blockNumber: events[0]?.blockNumber ?? "0",
                    txHash: events[0]?.txHash ?? ZERO_WORD,
                    hint: events[0]?.hint ?? ZERO_WORD,
                    ephemeralPubKey: events[0]?.ephemeralPubKey ?? ZERO_WORD,
                    encryptedPayload: "0x" as Hex,
                },
            ];
        }
        const body: Record<string, unknown> = { events, lastSyncedBlock: page.lastSyncedBlock };
        return mode === "drop-rows" ? corruptFirstRow(body) : body;
    }

    private async serveSnapshot(mode?: FaultMode): Promise<unknown> {
        const source = this.config.eventSource;
        if (!source?.getEventSnapshot) return NOT_IMPLEMENTED;
        const snapshot: WireEventSnapshot = await source.getEventSnapshot();
        return mode === "drop-rows" ? corruptFirstRow(snapshot) : snapshot;
    }

    private takeFault(endpoint: AspEndpoint): ActiveFault | undefined {
        const index = this.faults.findIndex((f) => f.endpoint === endpoint || f.endpoint === "*");
        if (index === -1) return undefined;
        const fault = this.faults[index];
        if (!fault) return undefined;
        if (fault.remaining !== null) {
            fault.remaining -= 1;
            if (fault.remaining <= 0) this.faults.splice(index, 1);
        }
        return fault;
    }

    /** @returns `true` when the fault fully handled the request. */
    private applyGenericFault(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        url: URL,
        endpoint: AspEndpoint,
        mode: FaultMode,
    ): boolean {
        switch (mode) {
            case "down":
                this.record(req, url, 0, endpoint);
                req.socket.destroy();
                return true;
            case "http500":
                this.record(req, url, 500, endpoint);
                this.sendJson(res, 500, { error: "injected_fault" });
                return true;
            case "not-implemented":
                this.record(req, url, 501, endpoint);
                this.sendJson(res, 501, { error: "not_implemented", message: "injected fault" });
                return true;
            case "malformed-json":
                this.record(req, url, 200, endpoint);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end("{not-json");
                return true;
            case "timeout":
                this.record(req, url, 0, endpoint);
                this.hanging.add(res);
                res.on("close", () => this.hanging.delete(res));
                return true;
            default:
                return false; // data-shaping modes are applied by the route handler
        }
    }

    private checkScope(
        url: URL,
        pathChainId?: string,
    ): { status: number; body: Record<string, string> } | null {
        const { scope } = this.config;
        if (pathChainId !== undefined && Number(pathChainId) !== scope.chainId) {
            return { status: 404, body: { error: "unknown_chain" } };
        }
        const queryChain = url.searchParams.get("chainId");
        if (queryChain !== null && Number(queryChain) !== scope.chainId) {
            return { status: 400, body: { error: "scope_mismatch", message: "chainId does not match" } };
        }
        const entrypoint = url.searchParams.get("entrypoint");
        if (
            scope.entrypoint !== undefined &&
            entrypoint !== null &&
            entrypoint.toLowerCase() !== scope.entrypoint.toLowerCase()
        ) {
            return {
                status: 400,
                body: { error: "scope_mismatch", message: "entrypoint does not match" },
            };
        }
        return null;
    }

    private async handleAdmin(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        url: URL,
    ): Promise<void> {
        const method = req.method ?? "GET";
        try {
            const body = method === "POST" ? await readJsonBody(req) : undefined;
            const result = await this.runAdmin(method, url.pathname, body);
            if (!result) {
                this.record(req, url, 404, "admin");
                this.sendJson(res, 404, { error: "not_found" });
                return;
            }
            this.record(req, url, result.status, "admin");
            this.sendJson(res, result.status, result.body);
        } catch (error) {
            const status =
                error instanceof BadRequestError ? 400 : error instanceof UnknownLabelError ? 404 : 500;
            const message = error instanceof Error ? error.message : String(error);
            this.log(`admin error (${status}): ${message}`);
            this.record(req, url, status, "admin");
            this.sendJson(res, status, {
                error: status === 500 ? "admin_failed" : "bad_request",
                message,
            });
        }
    }

    private async runAdmin(
        method: string,
        pathname: string,
        body: unknown,
    ): Promise<{ status: number; body: unknown } | null> {
        const args = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
        if (method === "GET" && pathname === "/admin/state") {
            return { status: 200, body: this.getState() };
        }
        if (method === "POST" && pathname === "/admin/approve-label") {
            const result = await this.approveLabel(parseLabel(args.label), {
                pushRoot: args.pushRoot === undefined ? undefined : args.pushRoot === true,
            });
            // `txHash` kept for the browser tooling that predates the chain-agnostic `txId`.
            return { status: 200, body: { ...result, txHash: result.txId } };
        }
        if (method === "POST" && pathname === "/admin/revoke-label") {
            const result = await this.revokeLabel(parseLabel(args.label));
            return { status: 200, body: { ...result, txHash: result.txId } };
        }
        if (method === "POST" && pathname === "/admin/label-status") {
            const status = args.status;
            if (typeof status !== "string" || !(LABEL_STATUSES as readonly string[]).includes(status)) {
                throw new BadRequestError(`status must be one of ${LABEL_STATUSES.join(", ")}`);
            }
            const labelStatus: LabelStatus = {
                status: status as LabelStatus["status"],
                ...(typeof args.timestamp === "number" ? { timestamp: args.timestamp } : {}),
            };
            if (args.leaf !== undefined) {
                this.setLabelStatus({ leaf: parseLabel(args.leaf) }, labelStatus);
            } else {
                this.setLabelStatus({ label: parseLabel(args.label) }, labelStatus);
            }
            return { status: 200, body: { ok: true } };
        }
        if (method === "POST" && pathname === "/admin/faults") {
            return { status: 201, body: this.addFault(args as unknown as FaultSpec) };
        }
        if (method === "DELETE" && pathname === "/admin/faults") {
            return { status: 200, body: { cleared: this.clearFaults() } };
        }
        if (method === "POST" && pathname === "/admin/reset") {
            this.reset();
            return { status: 200, body: { ok: true } };
        }
        return null;
    }

    private serialize<T>(work: () => Promise<T>): Promise<T> {
        const run = this.queue.then(work, work);
        this.queue = run.catch(() => undefined);
        return run;
    }

    private releaseHanging(): void {
        for (const res of this.hanging) res.destroy();
        this.hanging.clear();
    }

    private record(
        req: http.IncomingMessage,
        url: URL,
        status: number,
        endpoint: RequestLogEntry["endpoint"],
    ): void {
        const cacheControl = req.headers["cache-control"];
        this.requestLog.push({
            method: req.method ?? "GET",
            path: url.pathname,
            query: url.search,
            status,
            endpoint,
            ...(typeof cacheControl === "string" ? { cacheControl } : {}),
        });
    }

    private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(body));
    }

    private log(line: string): void {
        this.config.log?.(`[mock-asp] ${line}`);
    }
}

// -========- module-private helpers -========-

const NOT_IMPLEMENTED = Symbol("not-implemented");

interface Route {
    endpoint: AspEndpoint;
    pathChainId?: string;
    run: (mode: FaultMode | undefined, url: URL) => Promise<unknown>;
}

/** Accepts a `0x` hex or decimal string and returns canonical hex. */
function parseLabel(value: unknown): Hex {
    if (typeof value !== "string" || value.length === 0) {
        throw new BadRequestError("label (hex or decimal string) is required");
    }
    try {
        return (value.startsWith("0x") ? value : bigintToHex(BigInt(value))) as Hex;
    } catch {
        throw new BadRequestError(`label is not a valid hex or decimal number: ${value}`);
    }
}

/** `since` / `until` arrive as decimal block numbers. */
function parseBlockParam(value: string | null): bigint | undefined {
    if (value === null) return undefined;
    try {
        return BigInt(value);
    } catch {
        throw new BadRequestError(`block bound is not a decimal number: ${value}`);
    }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return undefined;
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        throw new BadRequestError("request body is not valid JSON");
    }
}

/**
 * The field a tolerant client treats as load-bearing for each row array. Corrupting it makes the
 * row unusable (dropped), rather than merely degraded, which is what a `drop-rows` fault means.
 * `leaves` carry no load-bearing field, so a corrupted leaf row is only ever degraded.
 */
const LOAD_BEARING_FIELD: Record<string, string> = {
    events: "hint",
    deposits: "outputCommitment",
    transacts: "outputCommitments",
    ragequits: "commitment",
    leaves: "leaf",
    keystoreLeaves: "leaf",
};

/** Copies `payload` with the load-bearing field of the first row of the first non-empty array corrupted. */
function corruptFirstRow(payload: Record<string, unknown>): Record<string, unknown> {
    for (const [key, field] of Object.entries(LOAD_BEARING_FIELD)) {
        const rows = payload[key];
        if (!Array.isArray(rows) || rows.length === 0) continue;
        const first = rows[0] as unknown;
        if (typeof first !== "object" || first === null) continue;
        // An object is invalid for every hex-string and array field involved.
        return { ...payload, [key]: [{ ...first, [field]: {} }, ...rows.slice(1)] };
    }
    return payload;
}
