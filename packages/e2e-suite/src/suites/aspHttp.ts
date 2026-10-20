import { beforeAll, expect, it } from "vitest";

import { ASPUnavailable, MerkleService, NoteStatus, PoseidonHashService } from "@privacy-pools-v2/core-sdk";
import type { Hex } from "@privacy-pools-v2/core-sdk";

import type { ChainE2E, ChainE2EDriver, ConformanceSession, E2EActor } from "../internal.js";
import { amountOf, describeSuite, discoverNotesWithRetry } from "../internal.js";

/**
 * The mock ASP as infrastructure (matrix "ASP over HTTP"): the real `HttpASPDataProvider` against the
 * server the chain's `globalSetup` started, with the chain's publisher writing roots to its ASP registry.
 * The exhaustive endpoint/fault matrix lives in `packages/mock-asp`'s own unit tests; what only an e2e can
 * prove is the chain side and that the SDK's sessions actually talk to it — i.e. that a chain's mock-ASP
 * adapter is wired correctly.
 */
export function aspHttpSuite(chain: ChainE2E): void {
    describeSuite(chain, "asp over http", [], (getDriver) => {
        let driver: ChainE2EDriver;
        let provider: ReturnType<ChainE2EDriver["aspProvider"]>;
        let merkle: MerkleService;
        let alice: E2EActor;

        beforeAll(async () => {
            driver = await getDriver();
            provider = driver.aspProvider();
            merkle = new MerkleService({ hashService: await PoseidonHashService.create() });
            alice = await driver.createActor("alice");
        });

        it("answer the health check", async () => {
            const res = await fetch(`${driver.asp.url}/health`);

            expect(await res.json()).toEqual({ status: "ok" });
        });

        it("publish each approved root to the chain's ASP registry", async () => {
            await driver.asp.approveLabel(("0x" + "a1".repeat(31) + "01") as Hex);

            expect(await driver.publishedAspRoot()).toBe(BigInt(await provider.getRoot()));
        });

        it("serve leaves whose Merkle root is the root the registry holds", async () => {
            const leaves = await provider.getLeaves();

            expect(BigInt(await merkle.computeRoot(leaves))).toBe(await driver.publishedAspRoot());
        });

        it("publish the shrunken root when a label is revoked and report it rejected", async () => {
            const label = ("0x" + "a2".repeat(31) + "02") as Hex;
            await driver.asp.approveLabel(label);
            const { leaf } = await driver.asp.revokeLabel(label);

            expect(await provider.getLabelStatus(leaf)).toEqual({ status: "rejected" });
            expect(BigInt(await merkle.computeRoot(await provider.getLeaves()))).toBe(await driver.publishedAspRoot());
        });

        it("report a never-approved label as pending", async () => {
            expect(await provider.getLabelStatus(("0x" + "ff".repeat(32)) as Hex)).toEqual({ status: "pending" });
        });

        it("reject a provider configured for a different entrypoint", async () => {
            const other = driver.aspProvider({ scope: "other" });

            await expect(other.getRoot()).rejects.toThrow(ASPUnavailable);
        });

        it("answer a browser preflight with CORS headers", async () => {
            const res = await fetch(`${driver.asp.url}/association-set/root`, { method: "OPTIONS" });

            expect(res.status).toBe(204);
            expect(res.headers.get("access-control-allow-origin")).toBe("*");
        });

        it("list injected faults in the admin state and forget them once cleared", async () => {
            await driver.asp.setFault({ endpoint: "root", mode: "http500", count: 5 });
            expect((await driver.asp.state()).faults).toHaveLength(1);

            await driver.asp.clearFaults();
            expect((await driver.asp.state()).faults).toHaveLength(0);
        });

        it("serve the SDK's own sessions: a deposit is discovered through a session configured with aspUrl", async () => {
            const fromBlock = await driver.currentBlock();
            const session: ConformanceSession = await driver.sessions.selfSubmit(alice);
            const prepared = await session.prepareDeposit({
                tokenId: driver.assets.native.id,
                value: amountOf(driver.assets.native, 10),
            });
            await session.executeDeposit(prepared);
            const fresh = await driver.sessions.selfSubmit(alice);

            const discovered = await discoverNotesWithRetry(driver, fresh, fromBlock);

            expect(discovered.find((n) => n.commitment === prepared.pendingNote.commitment)?.status).toBe(
                NoteStatus.PENDING,
            );
        });
    });
}
