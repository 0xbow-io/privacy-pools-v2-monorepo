import type { Hex } from "@privacy-pools-v2/core-sdk";
import { ASPUnavailable, bigintToHex } from "@privacy-pools-v2/core-sdk";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MockAspHttpServer } from "../../src/internal.js";
import {
    CHAIN_ID,
    createReference,
    ENTRYPOINT,
    FakeEventSource,
    FakePublisher,
    get,
    NOTE_EVENT,
    post,
    providerFor,
    startServer,
} from "./helpers.js";

const LABEL_A = "0x1111" as Hex;
const LABEL_B = "0x2222" as Hex;

describe("MockAspHttpServer", () => {
    let reference: Awaited<ReturnType<typeof createReference>>;
    let publisher: FakePublisher;
    let events: FakeEventSource;
    let server: MockAspHttpServer;

    beforeAll(async () => {
        reference = await createReference();
    });

    beforeEach(async () => {
        publisher = new FakePublisher();
        events = new FakeEventSource();
        server = await startServer({ publisher, eventSource: events });
    });

    afterEach(async () => {
        await server.stop();
    });

    describe("association set reads", () => {
        it("serve an empty set as root zero and no leaves", async () => {
            const provider = providerFor(server);

            expect(BigInt(await provider.getRoot())).toBe(0n);
            expect(await provider.getLeaves()).toEqual([]);
        });

        it("serve the leaf and the matching root after an approval", async () => {
            await server.approveLabel(LABEL_A);
            const provider = providerFor(server);
            const leaf = reference.leafFor(LABEL_A);

            expect((await provider.getLeaves()).map((l) => BigInt(l))).toEqual([BigInt(leaf)]);
            expect(BigInt(await provider.getRoot())).toBe(await reference.rootOf([leaf]));
        });

        it("serve leaves whose Merkle root equals the served root after several approvals", async () => {
            await server.approveLabel(LABEL_A);
            await server.approveLabel(LABEL_B);
            const provider = providerFor(server);

            const leaves = await provider.getLeaves();
            expect(BigInt(await provider.getRoot())).toBe(await reference.rootOf(leaves));
        });

        it("serve the ASP public key", async () => {
            const provider = providerFor(server);

            expect(await provider.getASPPublicKey()).toBe(server.publicKeyHex);
        });

        it("report pending before and approved after an approval", async () => {
            const provider = providerFor(server);
            const leaf = reference.leafFor(LABEL_A);

            expect(await provider.getLabelStatus(leaf)).toEqual({ status: "pending" });
            await server.approveLabel(LABEL_A);
            expect(await provider.getLabelStatus(leaf)).toEqual({ status: "approved" });
        });

        it("answer the health check", async () => {
            expect((await get(server, "/health")).body).toEqual({ status: "ok" });
        });

        it("answer an unknown route with 404", async () => {
            expect((await get(server, "/nope")).status).toBe(404);
        });
    });

    describe("approvals and revocations", () => {
        it("publish the new root on approval", async () => {
            const result = await server.approveLabel(LABEL_A);

            expect(result.published).toBe(true);
            expect(publisher.published).toEqual([await reference.rootOf([reference.leafFor(LABEL_A)])]);
        });

        it("skip publication when approval is told not to push the root", async () => {
            const result = await server.approveLabel(LABEL_A, { pushRoot: false });
            const provider = providerFor(server);

            expect(result.published).toBe(false);
            expect(publisher.published).toEqual([]);
            expect(await provider.getLeaves()).toHaveLength(1);
            expect(BigInt(await provider.getRoot())).toBe(0n);
        });

        it("not republish when the label is already approved and the root is unchanged", async () => {
            await server.approveLabel(LABEL_A);
            await server.approveLabel(LABEL_A);

            expect(publisher.published).toHaveLength(1);
        });

        it("leave state unchanged and answer 500 when the publisher rejects", async () => {
            publisher.failWith = "not the postman";
            const res = await post(server, "/admin/approve-label", { label: LABEL_A });

            expect(res.status).toBe(500);
            expect(res.body.message).toContain("not the postman");
            expect(server.state.leaves).toHaveLength(0);
        });

        it("serialize concurrent approvals so publications follow approval order", async () => {
            await Promise.all([server.approveLabel(LABEL_A), server.approveLabel(LABEL_B)]);

            expect(publisher.published).toEqual([
                await reference.rootOf([reference.leafFor(LABEL_A)]),
                await reference.rootOf([reference.leafFor(LABEL_A), reference.leafFor(LABEL_B)]),
            ]);
        });

        it("accept a decimal label through the admin API", async () => {
            const res = await post(server, "/admin/approve-label", { label: "4369" }); // 0x1111

            expect(res.status).toBe(200);
            expect(res.body.leaf).toBe(reference.leafFor(bigintToHex(4369n)));
        });

        it("keep the legacy txHash field in the approve response", async () => {
            const res = await post(server, "/admin/approve-label", { label: LABEL_A });

            expect(res.body.txHash).toBe("0xtx1");
        });

        it("reject an approval without a label with 400", async () => {
            expect((await post(server, "/admin/approve-label", {})).status).toBe(400);
        });

        it("reject an admin body that is not JSON with 400", async () => {
            expect((await post(server, "/admin/approve-label", "{oops")).status).toBe(400);
        });

        it("remove the leaf, republish, and mark the label rejected on revocation", async () => {
            await server.approveLabel(LABEL_A);
            await server.approveLabel(LABEL_B);
            const res = await post(server, "/admin/revoke-label", { label: LABEL_A });
            const provider = providerFor(server);

            expect(res.status).toBe(200);
            expect(publisher.published.at(-1)).toBe(await reference.rootOf([reference.leafFor(LABEL_B)]));
            expect(await provider.getLabelStatus(reference.leafFor(LABEL_A))).toEqual({ status: "rejected" });
            expect(await provider.getLeaves()).toHaveLength(1);
        });

        it("answer 404 when revoking a label that was never approved", async () => {
            expect((await post(server, "/admin/revoke-label", { label: LABEL_A })).status).toBe(404);
        });

        it("force a label status through the admin API", async () => {
            const provider = providerFor(server);
            const res = await post(server, "/admin/label-status", { label: LABEL_A, status: "poi_required" });

            expect(res.status).toBe(200);
            expect(await provider.getLabelStatus(reference.leafFor(LABEL_A))).toEqual({ status: "poi_required" });
        });

        it("reject an unknown label status with 400", async () => {
            const res = await post(server, "/admin/label-status", { label: LABEL_A, status: "banana" });

            expect(res.status).toBe(400);
        });

        it("clear label-status overrides and faults on reset but keep the leaves", async () => {
            await server.approveLabel(LABEL_A);
            server.setLabelStatus({ label: LABEL_A }, { status: "unknown" });
            server.addFault({ mode: "http500" });
            await post(server, "/admin/reset");

            const state = server.getState();
            expect(state.faults).toEqual([]);
            expect(state.labelStatusOverrides).toEqual({});
            expect(state.leaves).toHaveLength(1);
        });

        it("expose leaves, published root, faults and overrides through the state endpoint", async () => {
            await server.approveLabel(LABEL_A);
            const res = await get(server, "/admin/state");

            expect(res.status).toBe(200);
            expect(res.body.leaves).toHaveLength(1);
            expect(res.body.publishedRoot).toBe(publisher.published[0]!.toString());
        });
    });

    describe("scoping", () => {
        it("accept a request whose chainId and entrypoint match", async () => {
            const res = await get(server, `/association-set/root?chainId=${CHAIN_ID}&entrypoint=${ENTRYPOINT}`);

            expect(res.status).toBe(200);
        });

        it("compare the entrypoint case-insensitively", async () => {
            const res = await get(
                server,
                `/association-set/root?chainId=${CHAIN_ID}&entrypoint=${ENTRYPOINT.toUpperCase().replace("0X", "0x")}`,
            );

            expect(res.status).toBe(200);
        });

        it("reject a mismatching chainId query with 400", async () => {
            const res = await get(server, `/association-set/leaves?chainId=1&entrypoint=${ENTRYPOINT}`);

            expect(res.status).toBe(400);
            expect(res.body.error).toBe("scope_mismatch");
        });

        it("reject a mismatching entrypoint query with 400", async () => {
            const res = await get(server, `/association-set/root?chainId=${CHAIN_ID}&entrypoint=0x${"9".repeat(40)}`);

            expect(res.status).toBe(400);
        });

        it("answer 404 for a path chainId the ASP does not serve", async () => {
            const res = await get(server, `/1/public/note-events?entrypoint=${ENTRYPOINT}`);

            expect(res.status).toBe(404);
        });

        it("surface a provider configured for another entrypoint as ASPUnavailable", async () => {
            const provider = providerFor(server, { entrypointAddress: "0x" + "9".repeat(40) });

            await expect(provider.getRoot()).rejects.toBeInstanceOf(ASPUnavailable);
        });

        it("not enforce the entrypoint when the scope has none", async () => {
            const open = await startServer({ publisher, scope: { chainId: CHAIN_ID } });
            const res = await get(open, `/association-set/root?chainId=${CHAIN_ID}&entrypoint=0x${"9".repeat(40)}`);
            await open.stop();

            expect(res.status).toBe(200);
        });
    });

    describe("fault injection", () => {
        it("surface a destroyed connection as ASPUnavailable", async () => {
            server.addFault({ endpoint: "root", mode: "down" });

            await expect(providerFor(server).getRoot()).rejects.toBeInstanceOf(ASPUnavailable);
        });

        it("surface a 500 as ASPUnavailable", async () => {
            server.addFault({ endpoint: "leaves", mode: "http500" });

            await expect(providerFor(server).getLeaves()).rejects.toBeInstanceOf(ASPUnavailable);
        });

        it("surface a 501 as ASPUnavailable", async () => {
            server.addFault({ endpoint: "public-key", mode: "not-implemented" });

            await expect(providerFor(server).getASPPublicKey()).rejects.toBeInstanceOf(ASPUnavailable);
        });

        it("surface an unparseable body as ASPUnavailable", async () => {
            server.addFault({ endpoint: "root", mode: "malformed-json" });

            await expect(providerFor(server).getRoot()).rejects.toBeInstanceOf(ASPUnavailable);
        });

        it("surface a hung request as ASPUnavailable once the client times out", async () => {
            server.addFault({ endpoint: "root", mode: "timeout" });

            await expect(providerFor(server, { timeout: 250 }).getRoot()).rejects.toBeInstanceOf(ASPUnavailable);
        });

        it("apply a wildcard fault to every route", async () => {
            server.addFault({ mode: "http500" });
            const provider = providerFor(server);

            await expect(provider.getRoot()).rejects.toBeInstanceOf(ASPUnavailable);
            await expect(provider.getASPPublicKey()).rejects.toBeInstanceOf(ASPUnavailable);
        });

        it("recover once a counted fault is used up", async () => {
            server.addFault({ endpoint: "root", mode: "http500", count: 1 });
            const provider = providerFor(server);

            await expect(provider.getRoot()).rejects.toBeInstanceOf(ASPUnavailable);
            expect(BigInt(await provider.getRoot())).toBe(0n);
        });

        it("recover after faults are cleared through the admin API", async () => {
            server.addFault({ mode: "http500" });
            const cleared = await fetch(`${server.url}/admin/faults`, { method: "DELETE" });

            expect(((await cleared.json()) as { cleared: number }).cleared).toBe(1);
            expect(BigInt(await providerFor(server).getRoot())).toBe(0n);
        });

        it("never fault the admin API", async () => {
            server.addFault({ mode: "http500" });

            expect((await get(server, "/admin/state")).status).toBe(200);
        });

        it("serve the previous root while a stale-root fault is active", async () => {
            await server.approveLabel(LABEL_A);
            const first = await reference.rootOf([reference.leafFor(LABEL_A)]);
            await server.approveLabel(LABEL_B);
            server.addFault({ endpoint: "root", mode: "stale-root" });

            expect(BigInt(await providerFor(server).getRoot())).toBe(first);
        });

        it("serve leaves that cannot produce the served root while a bad-leaves fault is active", async () => {
            await server.approveLabel(LABEL_A);
            server.addFault({ endpoint: "leaves", mode: "bad-leaves" });
            const provider = providerFor(server);

            const leaves = await provider.getLeaves();
            expect(BigInt(await reference.rootOf(leaves))).not.toBe(BigInt(await provider.getRoot()));
        });

        it("register a fault through the admin API and reject an invalid one with 400", async () => {
            const ok = await post(server, "/admin/faults", { endpoint: "root", mode: "http500", count: 1 });
            const bad = await post(server, "/admin/faults", { endpoint: "leaves", mode: "stale-root" });

            expect(ok.status).toBe(201);
            expect(bad.status).toBe(400);
        });

        it("release a hung request when faults are cleared", async () => {
            server.addFault({ endpoint: "root", mode: "timeout" });
            const pending = fetch(`${server.url}/association-set/root`).then(
                () => "responded",
                () => "closed",
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
            server.clearFaults();

            expect(await pending).toBe("closed");
        });
    });

    describe("event endpoints", () => {
        it("answer 501 for note-events and the snapshot when no event source is configured", async () => {
            const bare = await startServer({ publisher });
            const provider = providerFor(bare);

            await expect(provider.getNoteEvents()).rejects.toBeInstanceOf(ASPUnavailable);
            await expect(provider.getEventSnapshot()).rejects.toBeInstanceOf(ASPUnavailable);
            expect((await get(bare, `/${CHAIN_ID}/public/note-events`)).status).toBe(501);
            await bare.stop();
        });

        it("serve note events and forward the requested block range to the source", async () => {
            const result = await providerFor(server).getNoteEvents("0x5" as Hex, "0xa" as Hex);

            expect(result.events).toHaveLength(1);
            expect(result.events[0]!.encryptedPayload).toBe(NOTE_EVENT.encryptedPayload);
            expect(result.lastSyncedBlock).toBe("0x10");
            expect(events.ranges).toEqual([{ since: 5n, until: 10n }]);
        });

        it("reject a non-decimal block bound with 400", async () => {
            const res = await get(server, `/${CHAIN_ID}/public/note-events?since=abc`);

            expect(res.status).toBe(400);
        });

        it("drop an empty-payload event on the client while delivering the rest", async () => {
            server.addFault({ endpoint: "note-events", mode: "empty-payload-events" });
            const result = await providerFor(server).getNoteEvents();

            expect(result.events).toHaveLength(1);
        });

        it("fail the whole note-events batch when a row is corrupted", async () => {
            server.addFault({ endpoint: "note-events", mode: "drop-rows" });

            await expect(providerFor(server).getNoteEvents()).rejects.toBeInstanceOf(ASPUnavailable);
        });

        it("serve a snapshot the client validates", async () => {
            const snapshot = await providerFor(server).getEventSnapshot();

            expect(snapshot.deposits).toHaveLength(1);
            expect(snapshot.drops).toBeUndefined();
        });

        it("report dropped rows on the snapshot when a row is corrupted", async () => {
            server.addFault({ endpoint: "event-snapshot", mode: "drop-rows" });
            const snapshot = await providerFor(server).getEventSnapshot();

            expect(snapshot.deposits).toHaveLength(0);
            expect(snapshot.drops?.deposits?.dropped).toBe(1);
        });
    });

    describe("http behaviour", () => {
        it("answer a preflight with 204 and CORS headers", async () => {
            const res = await fetch(`${server.url}/association-set/root`, { method: "OPTIONS" });

            expect(res.status).toBe(204);
            expect(res.headers.get("access-control-allow-origin")).toBe("*");
            expect(res.headers.get("access-control-allow-methods")).toContain("POST");
        });

        it("send CORS headers on error and 501 responses too", async () => {
            server.addFault({ endpoint: "root", mode: "http500" });
            const failed = await fetch(`${server.url}/association-set/root`);
            const missing = await fetch(`${server.url}/nope`);

            expect(failed.headers.get("access-control-allow-origin")).toBe("*");
            expect(missing.headers.get("access-control-allow-origin")).toBe("*");
        });

        it("honour a configured allowed origin", async () => {
            const scoped = await startServer({ publisher, allowOrigin: "http://localhost:4200" });
            const res = await fetch(`${scoped.url}/health`);
            await scoped.stop();

            expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:4200");
        });

        it("record the client's no-store request on mutable reads", async () => {
            const provider = providerFor(server);
            await provider.getRoot();
            await provider.getASPPublicKey();

            const log = server.getRequestLog();
            const root = log.find((entry) => entry.endpoint === "root");
            const key = log.find((entry) => entry.endpoint === "public-key");
            expect(root?.cacheControl).toBeDefined();
            expect(key?.cacheControl).toBeUndefined();
        });

        it("stop accepting connections after stop()", async () => {
            const url = server.url;
            await server.stop();

            await expect(fetch(`${url}/health`)).rejects.toThrow();
            server = await startServer({ publisher }); // so afterEach has something to stop
        });

        it("seed the served root from the registry when asked to", async () => {
            publisher.latest = 42n;
            const seeded = await startServer({ publisher, seedPublishedRoot: true });
            const res = await get(seeded, "/association-set/root");
            await seeded.stop();

            expect(res.body.root).toBe("42");
        });

        it("bind an ephemeral port by default so parallel servers never collide", async () => {
            const other = await startServer({ publisher });
            const same = other.port === server.port;
            await other.stop();

            expect(same).toBe(false);
        });
    });
});
