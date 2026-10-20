import { beforeAll, describe, expect, it } from "vitest";

import type { Hex } from "@privacy-pools-v2/core-sdk";
import {
    InvalidRageQuitParams,
    KeystoreNotRegistered,
    NoteNotFoundError,
    NoteStatus,
    RagequitNoteAlreadyExitedError,
    WalletSendTransactionFailed,
    WitnessPreparationFailed,
} from "@privacy-pools-v2/core-sdk";

import type { ChainE2E, ChainE2EDriver, ConformanceSession, E2EActor } from "../internal.js";
import { amountOf, describeSuite, exportedNote } from "../internal.js";

/**
 * Ragequit ladders (matrix §10): the emergency exit. It proves ownership of the note but never
 * consults the ASP, so it must work for a note the ASP never approved and for one it later revoked —
 * the two cases where an ordinary withdrawal cannot. It does need the owner's keystore leaf.
 */
export function ragequitSuite(chain: ChainE2E): void {
    describeSuite(chain, "ragequit", [], (getDriver) => {
        let driver: ChainE2EDriver;
        let fromBlock: Hex;
        let alice: E2EActor;
        let session: ConformanceSession;

        const value = () => amountOf(driver.assets.native, 8);
        const exported = exportedNote;

        const deposit = async (s: ConformanceSession, amount: Hex = value()) => {
            const prepared = await s.prepareDeposit({ tokenId: driver.assets.native.id, value: amount });
            await s.executeDeposit(prepared);
            return prepared.pendingNote;
        };

        /** An exit is EXIT_PENDING at submit; a scan past the finality boundary settles it to EXITED. */
        const settle = async (s: ConformanceSession) => {
            await driver.settleFinality();
            await s.discoverNotes({ fromBlock });
        };

        beforeAll(async () => {
            driver = await getDriver();
            fromBlock = await driver.currentBlock();
            alice = await driver.createActor("alice");
            session = await driver.sessions.selfSubmit(alice);
        });

        describe("an unapproved note", () => {
            let note: Awaited<ReturnType<typeof deposit>>;

            it("refuse a commitment the session has never seen with NoteNotFoundError", async () => {
                await expect(
                    session.prepareRageQuit({ commitment: ("0x" + "ab".repeat(32)) as Hex }),
                ).rejects.toThrow(NoteNotFoundError);
            });

            it("refuse a malformed commitment with InvalidRageQuitParams", async () => {
                await expect(session.prepareRageQuit({ commitment: "not-a-commitment" as Hex })).rejects.toThrow(
                    InvalidRageQuitParams,
                );
            });

            it("deposit a note and leave it unapproved", async () => {
                note = await deposit(session);

                expect((await exported(session, note.commitment))?.status).toBe(NoteStatus.PENDING);
            });

            it("refuse to exit before registering the keystore with KeystoreNotRegistered", async () => {
                expect(await session.isKeystoreRegistered()).toBe(false);

                await expect(session.prepareRageQuit({ commitment: note.commitment })).rejects.toThrow(
                    KeystoreNotRegistered,
                );
            });

            it("register the keystore", async () => {
                await session.registerKeystore();

                expect(await session.isKeystoreRegistered()).toBe(true);
            });

            it("prepare an exit that pays the note's owner the note's full value", async () => {
                const prepared = await session.prepareRageQuit({ commitment: note.commitment });

                expect(prepared.value).toBe(value());
                expect(prepared.recipientAddress).toBe(alice.address);
            });

            it("exit the unapproved note, bypassing the ASP entirely", async () => {
                const before = await driver.balanceOf(alice.address, driver.assets.native);

                const receipt = await session.rageQuit({ commitment: note.commitment });

                expect(receipt.status).toBe(true);
                const gained = (await driver.balanceOf(alice.address, driver.assets.native)) - before;
                expect(gained).toBeLessThanOrEqual(BigInt(value()));
                expect(gained).toBeGreaterThan(BigInt(value()) - driver.feeCeiling);
            });

            it("settle the exit to EXITED once the block is final", async () => {
                await settle(session);

                expect((await exported(session, note.commitment))?.status).toBe(NoteStatus.EXITED);
            });

            it("refuse to exit an EXITED note again with RagequitNoteAlreadyExitedError", async () => {
                await expect(session.prepareRageQuit({ commitment: note.commitment })).rejects.toThrow(
                    RagequitNoteAlreadyExitedError,
                );
            });

            it("let the chain decide when the caller overrides the local EXITED status", async () => {
                // `allowUnconfirmedExit` exists because EXITED can come from an unauthenticated ASP row; the
                // status guard is only a convenience. Here the exit really happened, so the chain refuses.
                await expect(
                    session.rageQuit({ commitment: note.commitment, allowUnconfirmedExit: true }),
                ).rejects.toThrow(WalletSendTransactionFailed);
            });
        });

        describe("a note whose label the ASP revoked", () => {
            let note: Awaited<ReturnType<typeof deposit>>;

            beforeAll(async () => {
                note = await deposit(session);
                // The ASP's leaf set is shared across files and append-only; approving an unrelated label
                // first guarantees revocation leaves a non-empty set (an empty root is a registry edge case).
                await driver.asp.approveLabel(("0x" + "5a".repeat(31) + "01") as Hex);
                await driver.asp.approveLabel(note.label);
                await settle(session);
            });

            it("start ACTIVE, as approved", async () => {
                expect((await exported(session, note.commitment))?.status).toBe(NoteStatus.ACTIVE);
            });

            it("fail to withdraw once the ASP has revoked the label, since no inclusion proof exists", async () => {
                await driver.asp.revokeLabel(note.label);

                await expect(
                    session.withdraw({
                        tokenId: driver.assets.native.id,
                        amount: value(),
                        recipientAddress: alice.address,
                        processorAddress: alice.address,
                        inputCommitments: [note.commitment],
                    }),
                ).rejects.toThrow(WitnessPreparationFailed);
            });

            it("recover the funds with a ragequit", async () => {
                const before = await driver.balanceOf(alice.address, driver.assets.native);

                const receipt = await session.rageQuit({ commitment: note.commitment });
                await settle(session);

                expect(receipt.status).toBe(true);
                expect((await driver.balanceOf(alice.address, driver.assets.native)) - before).toBeGreaterThan(
                    BigInt(value()) - driver.feeCeiling,
                );
                expect((await exported(session, note.commitment))?.status).toBe(NoteStatus.EXITED);
            });
        });

        describe("submitted by someone other than the owner", () => {
            let note: Awaited<ReturnType<typeof deposit>>;
            let prepared: Awaited<ReturnType<ConformanceSession["prepareRageQuit"]>>;

            it("prepare an exit for a fresh note", async () => {
                note = await deposit(session);
                prepared = await session.prepareRageQuit({ commitment: note.commitment });
            });

            it("revert when a different account submits it, as the vault requires the note's owner", async () => {
                // The proof binds the note's owner address, and the vault requires the submitter to be it: an
                // exit can only be triggered by the owner, never by a third party.
                const mallory = await driver.createActor("mallory");

                await expect(driver.submitPreparedTx(mallory, prepared.ragequitTx)).rejects.toThrow(
                    driver.revertReasons.ragequitNotOwner,
                );
            });

            it("still let the owner submit the very same prepared exit", async () => {
                const before = await driver.balanceOf(alice.address, driver.assets.native);

                const receipt = await session.executeRageQuit(prepared);

                expect(receipt.status).toBe(true);
                expect((await driver.balanceOf(alice.address, driver.assets.native)) - before).toBeGreaterThan(
                    BigInt(value()) - driver.feeCeiling,
                );
            });
        });
    });
}
