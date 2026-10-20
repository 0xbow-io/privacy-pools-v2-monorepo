#!/usr/bin/env node
/**
 * Instrumented JSON-RPC proxy for relayer perf tests.
 *
 * Sits between the relayer and anvil. Three jobs:
 *   1. Count JSON-RPC requests by method (and batched HTTP requests) so tests
 *      can assert RPC efficiency deterministically.
 *   2. Inject faults on demand: added latency, error responses, or hangs.
 *   3. Otherwise be a transparent passthrough.
 *
 * Zero dependencies — runs with bare `node` in a stock node:22 image.
 *
 * Control API (same port as the proxy, path-prefixed so it can never collide
 * with JSON-RPC POSTs to "/"):
 *   GET  /__perf/health  -> 200 "ok"
 *   GET  /__perf/stats   -> { httpRequests, batchedHttpRequests, rpcCalls: {method: n}, totalRpcCalls }
 *   POST /__perf/reset   -> zero all counters
 *   POST /__perf/mode    -> { kind: "passthrough"|"delay"|"error"|"hang",
 *                             latencyMs?: number,      // for "delay"
 *                             statusCode?: number,     // for "error", default 503
 *                             methods?: string[] }     // fault only these methods; empty/absent = all
 *
 * Env: UPSTREAM (default http://localhost:8545), PORT (default 8546),
 *      MAX_HANG_MS (default 120000 — "hang" responses are eventually dropped
 *      so sockets don't leak forever).
 */

import http from "node:http";

const UPSTREAM = process.env.UPSTREAM ?? "http://localhost:8545";
const PORT = Number(process.env.PORT ?? 8546);
const MAX_HANG_MS = Number(process.env.MAX_HANG_MS ?? 120_000);

const stats = {
    httpRequests: 0,
    batchedHttpRequests: 0,
    rpcCalls: {},
};

let mode = { kind: "passthrough", latencyMs: 0, statusCode: 503, methods: [] };

function resetStats() {
    stats.httpRequests = 0;
    stats.batchedHttpRequests = 0;
    stats.rpcCalls = {};
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function methodsOf(parsed) {
    if (Array.isArray(parsed)) return parsed.map((c) => c?.method ?? "unknown");
    return [parsed?.method ?? "unknown"];
}

function faultApplies(methods) {
    if (mode.kind === "passthrough") return false;
    if (!mode.methods || mode.methods.length === 0) return true;
    return methods.some((m) => mode.methods.includes(m));
}

async function handleControl(req, res, url) {
    if (req.method === "GET" && url === "/__perf/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
    }
    if (req.method === "GET" && url === "/__perf/stats") {
        const totalRpcCalls = Object.values(stats.rpcCalls).reduce((a, b) => a + b, 0);
        sendJson(res, 200, { ...stats, totalRpcCalls, mode });
        return;
    }
    if (req.method === "POST" && url === "/__perf/reset") {
        resetStats();
        sendJson(res, 200, { ok: true });
        return;
    }
    if (req.method === "POST" && url === "/__perf/mode") {
        try {
            const body = JSON.parse((await readBody(req)).toString() || "{}");
            const kind = body.kind ?? "passthrough";
            if (!["passthrough", "delay", "error", "hang"].includes(kind)) {
                sendJson(res, 400, { error: `unknown kind "${kind}"` });
                return;
            }
            mode = {
                kind,
                latencyMs: Number(body.latencyMs ?? 0),
                statusCode: Number(body.statusCode ?? 503),
                methods: Array.isArray(body.methods) ? body.methods : [],
            };
            console.log(`[rpc-proxy] mode -> ${JSON.stringify(mode)}`);
            sendJson(res, 200, { ok: true, mode });
            return;
        } catch (e) {
            sendJson(res, 400, { error: String(e) });
            return;
        }
    }
    sendJson(res, 404, { error: "unknown control endpoint" });
}

async function handleRpc(req, res) {
    const body = await readBody(req);

    let parsed = null;
    try {
        parsed = JSON.parse(body.toString());
    } catch {
        // Not JSON — still forward, count as unknown.
    }

    stats.httpRequests += 1;
    if (Array.isArray(parsed)) stats.batchedHttpRequests += 1;
    const methods = parsed ? methodsOf(parsed) : ["unparseable"];
    for (const m of methods) {
        stats.rpcCalls[m] = (stats.rpcCalls[m] ?? 0) + 1;
    }

    if (faultApplies(methods)) {
        if (mode.kind === "hang") {
            // Hold the socket open; the client's own timeout decides its fate.
            await sleep(MAX_HANG_MS);
            req.socket.destroy();
            return;
        }
        if (mode.kind === "error") {
            res.writeHead(mode.statusCode, { "content-type": "text/plain" });
            res.end("perf-proxy injected error");
            return;
        }
        if (mode.kind === "delay") {
            await sleep(mode.latencyMs);
        }
    }

    try {
        const upstream = await fetch(UPSTREAM, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });
        const respBody = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(respBody);
    } catch (e) {
        console.error(`[rpc-proxy] upstream error: ${e}`);
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`upstream error: ${e}`);
    }
}

const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const handler = url.startsWith("/__perf/") ? handleControl(req, res, url) : handleRpc(req, res);
    handler.catch((e) => {
        console.error(`[rpc-proxy] handler error: ${e}`);
        if (!res.headersSent) sendJson(res, 500, { error: String(e) });
    });
});

server.listen(PORT, () => {
    console.log(`[rpc-proxy] listening on :${PORT} -> ${UPSTREAM}`);
});
