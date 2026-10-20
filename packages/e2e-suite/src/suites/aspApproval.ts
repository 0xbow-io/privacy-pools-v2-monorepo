import { afterEach, beforeAll, expect, it } from "vitest";

import type { Hex } from "@privacy-pools-v2/core-sdk";
import { ASPUnavailable, NoteStatus } from "@privacy-pools-v2/core-sdk";

import type { ChainE2E, ChainE2EDriver, ConformanceSession, E2EActor } from "../internal.js";
import { amountOf, describeSuite, exportedNote } from "../internal.js";

/**
 * ASP compliance ladders (matrix §5), against the real HTTP ASP. Building a spend proof needs the
 * association set's leaves and root from the ASP; these rungs break that dependency in each way a
 * real ASP can fail, and prove the spend goes through as soon as the ASP is healthy again.
 */
export function aspApprovalSuite(chain: ChainE2E): void {
    describeSuite(chain, "asp approval", [], (getDriver) => {
        let driver: ChainE2EDriver;
        let fromBlock: Hex;
        let alice: E2EActor;
        let session: ConformanceSession;
        let noteA: Awaited<ReturnType<ConformanceSession["prepareDeposit"]>>["pendingNote"];
        let noteB: Awaited<ReturnType<ConformanceSession["prepareDeposit"]>>["pendingNote"];

        const exported = (commitment: Hex) => exportedNote(session, commitment);

        // A is the note the ladder tries to spend; B's approval is what gets held back.
        const withdrawA = () =>
            session.withdraw({
                tokenId: driver.assets.native.id,
                amount: amountOf(driver.assets.native, 20),
                recipientAddress: alice.address,
                processorAddress: alice.address,
                inputCommitments: [noteA.commitment],
            });

        beforeAll(async () => {
            driver = await getDriver();
            fromBlock = await driver.currentBlock();
            alice = await driver.createActor("alice");
            session = await driver.sessions.selfSubmit(alice);
            await session.registerKeystore();
            const a = await session.prepareDeposit({
                tokenId: driver.assets.native.id,
                value: amountOf(driver.assets.native, 20),
            });
            await session.executeDeposit(a);
            const b = await session.prepareDeposit({
                tokenId: driver.assets.native.id,
                value: amountOf(driver.assets.native, 10),
            });
            await session.executeDeposit(b);
            noteA = a.pendingNote;
            noteB = b.pendingNote;
            // Only A is approved so far; B's approval is the thing later rungs hold back.
            await driver.asp.approveLabel(noteA.label);
            await driver.settleFinality();
            await session.discoverNotes({ fromBlock });
        });

        // A failed rung must never leave a fault behind for the next one (or the next file).
        afterEach(async () => {
            await driver.asp.clearFaults();
        });

        it("start with the approved note ACTIVE and the unapproved one PENDING", async () => {
            expect((await exported(noteA.commitment))?.status).toBe(NoteStatus.ACTIVE);
            expect((await exported(noteB.commitment))?.status).toBe(NoteStatus.PENDING);
        });

        it("fail with ASPUnavailable when the ASP drops the connection, leaving the note untouched", async () => {
            await driver.asp.setFault({ endpoint: "leaves", mode: "down" });

            await expect(withdrawA()).rejects.toThrow(ASPUnavailable);
            expect((await exported(noteA.commitment))?.status).toBe(NoteStatus.ACTIVE);
        });

        it("fail with ASPUnavailable when the ASP answers with an error status", async () => {
            await driver.asp.setFault({ endpoint: "leaves", mode: "http500" });

            await expect(withdrawA()).rejects.toThrow(ASPUnavailable);
        });

        it("fail with ASPUnavailable when the ASP answers with a body that is not JSON", async () => {
            await driver.asp.setFault({ endpoint: "leaves", mode: "malformed-json" });

            await expect(withdrawA()).rejects.toThrow(ASPUnavailable);
        });

        // The client's provider aggregator reports a failed provider as ASPUnavailable("All providers
        // failed: ..."), so the specific ASPLeavesRootMismatch surfaces only in the message.
        it("refuse leaves that cannot produce the ASP's own published root, naming the root mismatch", async () => {
            await driver.asp.setFault({ endpoint: "leaves", mode: "bad-leaves" });

            const failure = await withdrawA().then(
                () => undefined,
                (error: unknown) => error,
            );

            expect(failure).toBeInstanceOf(ASPUnavailable);
            expect((failure as Error).message).toMatch(/leaves root mismatch/);
        });

        it("refuse a set whose leaves are ahead of the root the ASP has published on-chain", async () => {
            // Approved in the ASP but the new root was never pushed on-chain: the leaves now include B,
            // the registry still holds the root without it, so no proof over them could be accepted.
            await driver.asp.approveLabel(noteB.label, { pushRoot: false });

            const failure = await withdrawA().then(
                () => undefined,
                (error: unknown) => error,
            );

            expect(failure).toBeInstanceOf(ASPUnavailable);
            expect((failure as Error).message).toMatch(/leaves root mismatch/);
        });

        it("spend the note once the ASP publishes the pending root", async () => {
            await driver.asp.approveLabel(noteB.label);

            const receipt = await withdrawA();

            expect(receipt.status).toBe(true);
            expect((await exported(noteA.commitment))?.status).toBe(NoteStatus.SPENT);
        });

        it("turn the held-back note ACTIVE once it is approved and the session rescans", async () => {
            await driver.settleFinality();
            await session.discoverNotes({ fromBlock });

            expect((await exported(noteB.commitment))?.status).toBe(NoteStatus.ACTIVE);
        });
    });
}
