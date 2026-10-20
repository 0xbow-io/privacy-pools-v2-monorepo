import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * What the proxy does instead of (or to the response of) a forwarded relayer request.
 * - `down` — destroys the socket without answering (a relayer that is not there).
 * - `status` — answers with an HTTP error and never reaches the relayer.
 * - `timeout` — never answers; the client's own timeout is what ends the wait.
 * - `malformed` — answers 200 with a body that is not JSON.
 * - `respond` — answers with fixed JSON WITHOUT forwarding (e.g. a fake "submitted" reply).
 * - `rewrite` — forwards, then edits the relayer's JSON reply (a relayer that lies in its quote).
 */
export type ProxyAction =
    | { kind: "down" }
    | { kind: "status"; status: number; body?: unknown }
    | { kind: "timeout" }
    | { kind: "malformed" }
    | { kind: "respond"; body: unknown }
    | { kind: "rewrite"; edit: (json: unknown) => unknown };

export interface ProxyFault {
    /** Matched against the request path (`/v1/quote/...`, `/v1/relay/...`). */
    match: RegExp;
    action: ProxyAction;
    /** Apply to this many requests, then stop; omitted means until cleared. */
    count?: number;
}

/**
 * A fault-injecting HTTP proxy in front of the real local relayer. The relayer is a black box with no
 * fault hooks of its own, so a test points a session at the proxy and makes the "relayer" misbehave in
 * one specific way per rung; everything not matched is forwarded untouched.
 */
export class RelayerProxy {
    readonly requests: { method: string; path: string }[] = [];
    private readonly faults: ProxyFault[] = [];
    private readonly hanging = new Set<http.ServerResponse>();
    private readonly server: http.Server;
    private baseUrl = "";

    static async start(target: string): Promise<RelayerProxy> {
        const proxy = new RelayerProxy(target);
        await new Promise<void>((resolve, reject) => {
            proxy.server.once("error", reject);
            proxy.server.listen(0, "127.0.0.1", () => {
                proxy.baseUrl = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`;
                resolve();
            });
        });
        return proxy;
    }

    private constructor(private readonly target: string) {
        this.server = http.createServer((req, res) => {
            void this.handle(req, res).catch(() => {
                if (!res.headersSent) res.writeHead(502);
                res.end();
            });
        });
    }

    get url(): string {
        return this.baseUrl;
    }

    addFault(fault: ProxyFault): void {
        this.faults.push({ ...fault });
    }

    clearFaults(): void {
        this.faults.length = 0;
        for (const res of this.hanging) res.destroy();
        this.hanging.clear();
    }

    async stop(): Promise<void> {
        this.clearFaults();
        this.server.closeAllConnections();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    private takeFault(path: string): ProxyFault | undefined {
        const index = this.faults.findIndex((f) => f.match.test(path));
        const fault = this.faults[index];
        if (fault === undefined) return undefined;
        if (fault.count !== undefined && --fault.count <= 0) this.faults.splice(index, 1);
        return fault;
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const path = req.url ?? "/";
        const method = req.method ?? "GET";
        this.requests.push({ method, path });
        const fault = this.takeFault(path);
        const action = fault?.action;

        if (action?.kind === "down") return void req.socket.destroy();
        if (action?.kind === "timeout") {
            this.hanging.add(res);
            res.on("close", () => this.hanging.delete(res));
            return;
        }
        if (action?.kind === "status") {
            res.writeHead(action.status, { "content-type": "application/json" });
            return void res.end(JSON.stringify(action.body ?? { message: "injected relayer fault" }));
        }
        if (action?.kind === "malformed") {
            res.writeHead(200, { "content-type": "application/json" });
            return void res.end("{not-json");
        }
        if (action?.kind === "respond") {
            res.writeHead(200, { "content-type": "application/json" });
            return void res.end(JSON.stringify(action.body));
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const upstream = await fetch(`${this.target}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
        });
        let text = await upstream.text();
        if (action?.kind === "rewrite") {
            text = JSON.stringify(action.edit(JSON.parse(text) as unknown));
        }
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(text);
    }
}

/** Recursively sets every numeric `expiration` field, however deeply the relayer nests it. */
export function setExpiration(json: unknown, expirationMs: number): unknown {
    if (Array.isArray(json)) return json.map((item) => setExpiration(item, expirationMs));
    if (json !== null && typeof json === "object") {
        return Object.fromEntries(
            Object.entries(json as Record<string, unknown>).map(([key, value]) => [
                key,
                key === "expiration" && typeof value === "number" ? expirationMs : setExpiration(value, expirationMs),
            ]),
        );
    }
    return json;
}
