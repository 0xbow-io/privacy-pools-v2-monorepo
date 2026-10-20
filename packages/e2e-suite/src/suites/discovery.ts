import { beforeAll, describe, expect, it } from "vitest";

import type { Hex } from "@privacy-pools-v2/core-sdk";
import { AccountExportMismatch, NoteDiscoveryScanFailed, NoteStatus } from "@privacy-pools-v2/core-sdk";

import type { ChainE2E, ChainE2EDriver, ConformanceSession, E2EActor } from "../internal.js";
import { amountOf, describeSuite, discoverNotesWithRetry, randomProtocolKeys } from "../internal.js";

/**
 * Discovery and sync ladders (matrix §9). Scanning needs the account's VIEWING PRIVATE KEY, held
 * locally: an address alone finds nothing, and registering on-chain only lets *senders* encrypt to you.
 */
export function discoverySuite(chain: ChainE2E): void {
    describeSuite(chain, "discovery", [], (getDriver) => {
        let driver: ChainE2EDriver;
        let fromBlock: Hex;
        let alice: E2EActor;
        let session: ConformanceSession;
        let note: Awaited<ReturnType<ConformanceSession["prepareDeposit"]>>["pendingNote"];

        const known = async (s: ConformanceSession) => (await s.exportAccount()).notes;

        beforeAll(async () => {
            driver = await getDriver();
            fromBlock = await driver.currentBlock();
            alice = await driver.createActor("alice");
            session = await driver.sessions.selfSubmit(alice);
            const prepared = await session.prepareDeposit({
                tokenId: driver.assets.native.id,
                value: amountOf(driver.assets.native, 10),
            });
            await session.executeDeposit(prepared);
            note = prepared.pendingNote;
        });

        it("find the deposit from a fresh session that holds the account's keys, without any registration", async () => {
            const fresh = await driver.sessions.selfSubmit(alice);
            expect(await fresh.isKeystoreRegistered()).toBe(false);

            const discovered = await discoverNotesWithRetry(driver, fresh, fromBlock);

            expect(discovered.find((n) => n.commitment === note.commitment)?.status).toBe(NoteStatus.PENDING);
        });

        it("find nothing when a session has the right address but not the viewing key", async () => {
            // Same ownerAddress, entirely different protocol keys: nothing on-chain is addressed to them.
            const eve = await driver.sessions.selfSubmit({ ...alice, keys: randomProtocolKeys() });

            const discovered = await discoverNotesWithRetry(driver, eve, fromBlock);

            expect(discovered).toHaveLength(0);
        });

        it("report nothing new on a repeat scan and keep the account state unchanged", async () => {
            const before = await known(session);

            const again = await session.discoverNotes({ fromBlock });

            expect(again).toHaveLength(0);
            expect((await known(session)).map((n) => n.commitment)).toEqual(before.map((n) => n.commitment));
        });

        it("find nothing when the scan starts after the deposit's block", async () => {
            await driver.settleFinality();
            const later = await driver.currentBlock();
            const fresh = await driver.sessions.selfSubmit(alice);

            expect(await fresh.discoverNotes({ fromBlock: later })).toHaveLength(0);
        });

        it("turn the note ACTIVE once the ASP approves it and the session rescans", async () => {
            await driver.asp.approveLabel(note.label);
            await driver.settleFinality();

            await session.discoverNotes({ fromBlock });

            expect((await known(session)).find((n) => n.commitment === note.commitment)?.status).toBe(
                NoteStatus.ACTIVE,
            );
        });

        describe("account export", () => {
            it("restore the same notes into a fresh session without scanning", async () => {
                const exported = await session.exportAccount();
                const restored = await driver.sessions.selfSubmit(alice);

                await restored.importAccount(exported);

                expect((await known(restored)).map((n) => [n.commitment, n.status])).toEqual(
                    exported.notes.map((n) => [n.commitment, n.status]),
                );
            });

            it("refuse an export that belongs to a different owner with AccountExportMismatch", async () => {
                const bob = await driver.createActor("bob");
                const bobSession = await driver.sessions.selfSubmit(bob);

                await expect(bobSession.importAccount(await session.exportAccount())).rejects.toThrow(
                    AccountExportMismatch,
                );
            });
        });

        describe("when the environment misbehaves", () => {
            it("report an unreachable RPC as NoteDiscoveryScanFailed", async () => {
                const broken = await driver.sessions.selfSubmitWithUnreachableRpc(alice);

                await expect(broken.discoverNotes({ fromBlock })).rejects.toThrow(NoteDiscoveryScanFailed);
            });

            it("keep discovering while the ASP's event snapshot is down", async () => {
                // The snapshot is an optional accelerator; with it failing, discovery falls back to scanning
                // the chain itself and must still find the account's notes.
                await driver.asp.setFault({ endpoint: "event-snapshot", mode: "down" });
                try {
                    const fresh = await driver.sessions.selfSubmit(alice);

                    const discovered = await fresh.discoverNotes({ fromBlock });

                    expect(discovered.find((n) => n.commitment === note.commitment)).toBeDefined();
                } finally {
                    await driver.asp.clearFaults();
                }
            });
        });
    });
}
