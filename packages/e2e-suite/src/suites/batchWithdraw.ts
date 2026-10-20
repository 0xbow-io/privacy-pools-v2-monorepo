import { beforeAll, expect, it } from "vitest";

import type { Hex } from "@privacy-pools-v2/core-sdk";
import { bigintToHex, EmptyBatchSelection, NoteStatus, RelayerRequestFailed } from "@privacy-pools-v2/core-sdk";

import type { ChainE2E, ChainE2EDriver, ConformanceSession, E2EActor } from "../internal.js";
import { amountOf, describeSuite, describeWith, exportedNote, need } from "../internal.js";

/**
 * Batch withdrawal ladders (matrix §7): every ACTIVE note of one asset, to one recipient, in a single
 * transaction — one proof per distinct deposit label, so two labels means a two-item batch.
 */
export function batchWithdrawSuite(chain: ChainE2E): void {
    describeSuite(chain, "batch withdraw", [], (getDriver) => {
        let driver: ChainE2EDriver;
        let fromBlock: Hex;

        const noteF = () => amountOf(driver.assets.native, 6);
        const noteG = () => amountOf(driver.assets.native, 9);

        const deposit = async (s: ConformanceSession, value: Hex) => {
            const prepared = await s.prepareDeposit({ tokenId: driver.assets.native.id, value });
            await s.executeDeposit(prepared);
            return prepared.pendingNote;
        };
        const exported = exportedNote;

        beforeAll(async () => {
            driver = await getDriver();
            fromBlock = await driver.currentBlock();
        });

        describeWith(chain, ["relayer", "batchRelay"], "selection and fees", () => {
            let alice: E2EActor;
            let dusty: E2EActor;
            let session: ConformanceSession;
            let dustySession: ConformanceSession;

            beforeAll(async () => {
                alice = await driver.createActor("alice");
                dusty = await driver.createActor("dusty");
                session = await need(driver, "relayer").relayedSession(alice);
                dustySession = await need(driver, "relayer").relayedSession(dusty);
                await session.registerKeystore();
                await dustySession.registerKeystore();
            });

            it("refuse a batch when the account holds no notes with EmptyBatchSelection", async () => {
                await expect(
                    session.prepareBatchWithdraw({ tokenId: driver.assets.native.id, recipientAddress: alice.address }),
                ).rejects.toThrow(EmptyBatchSelection);
            });

            it("still refuse while the only notes are unapproved, since PENDING notes are never selected", async () => {
                await deposit(session, noteF());

                await expect(
                    session.prepareBatchWithdraw({ tokenId: driver.assets.native.id, recipientAddress: alice.address }),
                ).rejects.toThrow(EmptyBatchSelection);
            });

            it("refuse a batch whose notes cannot cover the relayer's fee, as the relayer's quote refusal", async () => {
                const dust = await deposit(dustySession, bigintToHex(driver.assets.native.dust));
                await driver.asp.approveLabel(dust.label);
                await driver.settleFinality();
                await dustySession.discoverNotes({ fromBlock });
                expect((await exported(dustySession, dust.commitment))?.status).toBe(NoteStatus.ACTIVE);

                // The relayer refuses to quote a fee larger than the note (HTTP 400) before the SDK's own
                // InfeasibleBatchFee check is reached, so the caller sees RelayerRequestFailed.
                const failure = await dustySession
                    .prepareBatchWithdraw({ tokenId: driver.assets.native.id, recipientAddress: dusty.address })
                    .then(
                        () => undefined,
                        (error: unknown) => error,
                    );

                expect(failure).toBeInstanceOf(RelayerRequestFailed);
                expect((failure as Error).message).toMatch(/exceeds its withdrawn amount/);
            });
        });

        describeWith(chain, ["relayer", "batchRelay"], "a relayed two-item batch", () => {
            let alice: E2EActor;
            let dest: E2EActor;
            let session: ConformanceSession;
            let f: Awaited<ReturnType<typeof deposit>>;
            let g: Awaited<ReturnType<typeof deposit>>;

            beforeAll(async () => {
                alice = await driver.createActor("alice-batch");
                // A gasless destination: what it ends up holding is exactly what the relayer delivered.
                dest = await driver.createActor("dest", { funded: false });
                session = await need(driver, "relayer").relayedSession(alice);
                await session.registerKeystore();
                // Two separate deposits are two labels, which is what forces two items into the batch.
                f = await deposit(session, noteF());
                g = await deposit(session, noteG());
                await driver.asp.approveLabel(f.label);
                await driver.asp.approveLabel(g.label);
                await driver.settleFinality();
                await session.discoverNotes({ fromBlock });
            });

            it("prepare one item per deposit label", async () => {
                const prepared = await session.prepareBatchWithdraw({
                    tokenId: driver.assets.native.id,
                    recipientAddress: dest.address,
                });

                expect(prepared.items).toHaveLength(2);
            });

            it("withdraw both notes in a single relayed transaction, the fee coming out of the notes", async () => {
                const prepared = await session.prepareBatchWithdraw({
                    tokenId: driver.assets.native.id,
                    recipientAddress: dest.address,
                });

                // A delta, not a balance: an "unfunded" account still holds its base reserve on Stellar.
                const before = await driver.balanceOf(dest.address, driver.assets.native);
                const receipt = await session.relayBatchWithdraw(prepared);

                expect(receipt.status).toBe(true);
                const total = BigInt(noteF()) + BigInt(noteG());
                const delivered = (await driver.balanceOf(dest.address, driver.assets.native)) - before;
                expect(delivered).toBeLessThanOrEqual(total);
                expect(delivered).toBeGreaterThan(total - driver.feeCeiling);
                expect((await exported(session, f.commitment))?.status).toBe(NoteStatus.SPENT);
                expect((await exported(session, g.commitment))?.status).toBe(NoteStatus.SPENT);
            });

            it("have nothing left to batch afterwards", async () => {
                await expect(
                    session.prepareBatchWithdraw({ tokenId: driver.assets.native.id, recipientAddress: dest.address }),
                ).rejects.toThrow(EmptyBatchSelection);
            });
        });

        describeWith(chain, "batchRelay", "a self-submitted batch", () => {
            it("withdraw without a relayer, paying gas from the account", async () => {
                const bob = await driver.createActor("bob-batch");
                const session = await driver.sessions.selfSubmit(bob);
                await session.registerKeystore();
                const note = await deposit(session, noteG());
                await driver.asp.approveLabel(note.label);
                await driver.settleFinality();
                await session.discoverNotes({ fromBlock });
                const before = await driver.balanceOf(bob.address, driver.assets.native);

                const receipt = await session.selfSubmitBatchWithdraw({
                    tokenId: driver.assets.native.id,
                    recipientAddress: bob.address,
                    relayContractAddress: driver.relayContract,
                });

                expect(receipt.status).toBe(true);
                expect((await driver.balanceOf(bob.address, driver.assets.native)) - before).toBeGreaterThan(
                    BigInt(noteG()) - driver.feeCeiling,
                );
                expect((await exported(session, note.commitment))?.status).toBe(NoteStatus.SPENT);
            });
        });
    });
}
