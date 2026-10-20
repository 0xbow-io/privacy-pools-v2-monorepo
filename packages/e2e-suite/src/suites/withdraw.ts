import { beforeAll, describe, expect, it } from "vitest";

import type { Hex } from "@privacy-pools-v2/core-sdk";
import {
    bigintToHex,
    InsufficientTransactValue,
    InvalidTransactParams,
    KeystoreNotRegistered,
    NoteNotFoundError,
    NoteStatus,
    RegistrationDeadlineInPast,
    TransactNoteNotActive,
    WalletSendTransactionFailed,
} from "@privacy-pools-v2/core-sdk";

import type { ChainE2E, ChainE2EDriver, ConformanceSession, E2EActor } from "../internal.js";
import {
    amountOf,
    describeSuite,
    describeWith,
    discoverNotesWithRetry,
    exportedNote,
    itWith,
    need,
} from "../internal.js";

type PendingNote = Awaited<ReturnType<ConformanceSession["prepareDeposit"]>>["pendingNote"];

/**
 * Withdraw ladders (matrix §6): self-submit, relayed, and the gasless register-and-withdraw. Spending is
 * the operation with the most requirements, so each rung removes exactly one blocker, in the order the
 * SDK checks them: note exists → note ACTIVE (ASP-approved and rescanned) → keystore registered →
 * amounts and params → on-chain state.
 */
export function withdrawSuite(chain: ChainE2E): void {
    describeSuite(chain, "withdraw", [], (getDriver) => {
        let driver: ChainE2EDriver;
        let fromBlock: Hex;

        // Note values, in suite units of the native asset.
        const noteAValue = () => amountOf(driver.assets.native, 20);
        const noteBValue = () => amountOf(driver.assets.native, 30);
        // A relayed withdrawal pays the relayer's fee out of the same note, so it must ask for LESS than the
        // note's full value. Two units of headroom comfortably cover the fee observed on a local chain.
        const relayerFeeHeadroom = () => driver.assets.native.unit * 2n;

        const exported = exportedNote;

        /** Approves the label through the ASP's admin API, finalizes, and rescans so the note turns ACTIVE. */
        const activate = async (session: ConformanceSession, label: Hex, commitment: Hex) => {
            await driver.asp.approveLabel(label);
            await driver.settleFinality();
            await session.discoverNotes({ fromBlock });
            expect((await exported(session, commitment))?.status).toBe(NoteStatus.ACTIVE);
        };

        beforeAll(async () => {
            driver = await getDriver();
            fromBlock = await driver.currentBlock();
        });

        describe("self-submit withdrawal", () => {
            let alice: E2EActor;
            let session: ConformanceSession;
            let stale: ConformanceSession;
            let noteA: PendingNote;
            let noteB: PendingNote;

            const withdrawA = (overrides: Record<string, unknown> = {}, on: ConformanceSession = session) =>
                on.withdraw({
                    tokenId: driver.assets.native.id,
                    amount: noteAValue(),
                    recipientAddress: alice.address,
                    processorAddress: alice.address,
                    inputCommitments: [noteA.commitment],
                    ...overrides,
                });

            beforeAll(async () => {
                alice = await driver.createActor("alice");
                session = await driver.sessions.selfSubmit(alice);
            });

            it("refuse a commitment the session has never seen with NoteNotFoundError", async () => {
                await expect(
                    session.withdraw({
                        tokenId: driver.assets.native.id,
                        amount: noteAValue(),
                        recipientAddress: alice.address,
                        processorAddress: alice.address,
                        inputCommitments: [("0x" + "ab".repeat(32)) as Hex],
                    }),
                ).rejects.toThrow(NoteNotFoundError);
            });

            it("deposit the notes to spend", async () => {
                const a = await session.prepareDeposit({ tokenId: driver.assets.native.id, value: noteAValue() });
                await session.executeDeposit(a);
                const b = await session.prepareDeposit({ tokenId: driver.assets.native.id, value: noteBValue() });
                await session.executeDeposit(b);
                noteA = a.pendingNote;
                noteB = b.pendingNote;

                expect((await exported(session, noteA.commitment))?.status).toBe(NoteStatus.PENDING);
            });

            it("refuse to spend a note the ASP has not approved with TransactNoteNotActive", async () => {
                await expect(withdrawA()).rejects.toThrow(TransactNoteNotActive);
            });

            it("keep refusing after approval until the session rescans", async () => {
                await driver.asp.approveLabel(noteA.label);
                await driver.asp.approveLabel(noteB.label);

                // Approved in the ASP, but this session's local status is still PENDING.
                await expect(withdrawA()).rejects.toThrow(TransactNoteNotActive);
            });

            it("turn the notes ACTIVE once the session rescans", async () => {
                await driver.settleFinality();
                await session.discoverNotes({ fromBlock });

                expect((await exported(session, noteA.commitment))?.status).toBe(NoteStatus.ACTIVE);
                expect((await exported(session, noteB.commitment))?.status).toBe(NoteStatus.ACTIVE);
            });

            it("refuse to spend before registering the keystore with KeystoreNotRegistered", async () => {
                expect(await session.isKeystoreRegistered()).toBe(false);

                await expect(withdrawA()).rejects.toThrow(KeystoreNotRegistered);
            });

            it("register the keystore", async () => {
                await session.registerKeystore();

                expect(await session.isKeystoreRegistered()).toBe(true);
            });

            it("refuse an amount above the note's value with InsufficientTransactValue", async () => {
                await expect(withdrawA({ amount: bigintToHex(BigInt(noteAValue()) + 1n) })).rejects.toThrow(
                    InsufficientTransactValue,
                );
            });

            itWith(chain, "token", "refuse a token that differs from the note's with InvalidTransactParams", async () => {
                await expect(withdrawA({ tokenId: need(driver, "token").tokenAsset.id })).rejects.toThrow(
                    InvalidTransactParams,
                );
            });

            it("refuse the same input note listed twice with InvalidTransactParams", async () => {
                await expect(withdrawA({ inputCommitments: [noteA.commitment, noteA.commitment] })).rejects.toThrow(
                    InvalidTransactParams,
                );
            });

            it("refuse a malformed recipient address with InvalidTransactParams", async () => {
                await expect(withdrawA({ recipientAddress: "0x1234" })).rejects.toThrow(InvalidTransactParams);
            });

            it("withdraw the full note to the owner", async () => {
                // A second session that has seen noteA ACTIVE, kept to prove a stale view below.
                stale = await driver.sessions.selfSubmit(alice);
                await discoverNotesWithRetry(driver, stale, fromBlock);
                const before = await driver.balanceOf(alice.address, driver.assets.native);

                const receipt = await withdrawA();

                expect(receipt.status).toBe(true);
                const gained = (await driver.balanceOf(alice.address, driver.assets.native)) - before;
                expect(gained).toBeLessThanOrEqual(BigInt(noteAValue()));
                expect(gained).toBeGreaterThan(BigInt(noteAValue()) - driver.feeCeiling);
            });

            it("mark the note SPENT in the session that spent it, and refuse to spend it again", async () => {
                expect((await exported(session, noteA.commitment))?.status).toBe(NoteStatus.SPENT);

                await expect(withdrawA()).rejects.toThrow(TransactNoteNotActive);
            });

            it("revert on-chain when a session that never saw the spend tries to spend it again", async () => {
                // The SDK cannot know: this session still believes noteA is ACTIVE, builds a valid proof,
                // and only the chain (nullifier already used) can refuse it.
                await expect(withdrawA({}, stale)).rejects.toThrow(WalletSendTransactionFailed);
            });

            it("see the spend as SPENT from a fresh session after finality", async () => {
                const fresh = await driver.sessions.selfSubmit(alice);
                await discoverNotesWithRetry(driver, fresh, fromBlock);

                expect((await exported(fresh, noteA.commitment))?.status).toBe(NoteStatus.SPENT);
                expect((await exported(fresh, noteB.commitment))?.status).toBe(NoteStatus.ACTIVE);
            });

            describeWith(chain, "relayer", "relayed withdrawal of the remaining note", () => {
                let relayed: ConformanceSession;
                let dest: E2EActor;

                beforeAll(async () => {
                    // A gasless destination: it never pays for anything, so the balance it ends with is
                    // exactly what the relayer delivered.
                    dest = await driver.createActor("dest", { funded: false });
                    relayed = await need(driver, "relayer").relayedSession(alice);
                    await discoverNotesWithRetry(driver, relayed, fromBlock);
                });

                const quoteFor = (amount: bigint) =>
                    need(driver, "relayer").withdrawalQuote({ asset: driver.assets.native, recipient: dest.address, amount });

                it("refuse to withdraw the full note because the relayer's fee has nothing to come from", async () => {
                    const selectedQuote = await quoteFor(BigInt(noteBValue()));

                    await expect(
                        relayed.relayWithdraw({
                            inputCommitments: [noteB.commitment],
                            amount: noteBValue(),
                            tokenId: driver.assets.native.id,
                            recipientAddress: dest.address,
                            selectedQuote,
                        }),
                    ).rejects.toThrow(InsufficientTransactValue);
                });

                it("deliver exactly the requested amount when the fee fits inside the note", async () => {
                    const amount = BigInt(noteBValue()) - relayerFeeHeadroom();
                    const selectedQuote = await quoteFor(amount);
                    // Delta, not an absolute balance: an "unfunded" destination is `0` on EVM but
                    // can't be on Stellar (an account can't exist below its minimum reserve), so
                    // `dest` may already hold a nonzero starting balance there.
                    const before = await driver.balanceOf(dest.address, driver.assets.native);

                    const receipt = await relayed.relayWithdraw({
                        inputCommitments: [noteB.commitment],
                        amount: bigintToHex(amount),
                        tokenId: driver.assets.native.id,
                        recipientAddress: dest.address,
                        selectedQuote,
                    });

                    expect(receipt.status).toBe(true);
                    expect((await driver.balanceOf(dest.address, driver.assets.native)) - before).toBe(amount);
                    expect((await exported(relayed, noteB.commitment))?.status).toBe(NoteStatus.SPENT);
                });
            });
        });

        describeWith(chain, ["relayer", "registerAndWithdraw"], "gasless register-and-withdraw", () => {
            let carol: E2EActor;
            let session: ConformanceSession;
            let note: PendingNote;
            const amount = () => BigInt(noteBValue()) - relayerFeeHeadroom();
            const deadline = (seconds: number): Hex => bigintToHex(BigInt(Math.floor(Date.now() / 1000) + seconds));

            const paramsFor = async (extra: { signature: Hex; deadline: Hex }) => ({
                inputCommitments: [note.commitment],
                amount: bigintToHex(amount()),
                tokenId: driver.assets.native.id,
                recipientAddress: carol.address,
                selectedQuote: await need(driver, "relayer").withdrawalQuote({
                    asset: driver.assets.native,
                    recipient: carol.address,
                    amount: amount(),
                }),
                ...extra,
            });

            beforeAll(async () => {
                // Carol deposits (needs gas, but no registration), then loses every wei: from here she is
                // an unregistered account holding an ACTIVE note and no gas — the cold-start recipient.
                carol = await driver.createActor("carol");
                session = await need(driver, "relayer").relayedSession(carol);
                const prepared = await session.prepareDeposit({
                    tokenId: driver.assets.native.id,
                    value: noteBValue(),
                });
                await session.executeDeposit(prepared);
                note = prepared.pendingNote;
                await activate(session, note.label, note.commitment);
                await driver.drainNative(carol.address);
            });

            it("start unregistered with no gas", async () => {
                expect(await session.isKeystoreRegistered()).toBe(false);
                expect(await driver.balanceOf(carol.address, driver.assets.native)).toBe(
                    need(driver, "registerAndWithdraw").drainedNativeBalance,
                );
            });

            it("refuse a plain relayed withdrawal with KeystoreNotRegistered", async () => {
                const params = await paramsFor({ signature: "0x" as Hex, deadline: deadline(3600) });

                await expect(
                    session.relayWithdraw({
                        inputCommitments: params.inputCommitments,
                        amount: params.amount,
                        tokenId: params.tokenId,
                        recipientAddress: params.recipientAddress,
                        selectedQuote: params.selectedQuote,
                    }),
                ).rejects.toThrow(KeystoreNotRegistered);
            });

            it("refuse a registration whose deadline has passed with RegistrationDeadlineInPast", async () => {
                const params = await paramsFor({
                    signature: ("0x" + "00".repeat(65)) as Hex,
                    deadline: deadline(-60),
                });

                await expect(session.registerAndWithdraw(params)).rejects.toThrow(RegistrationDeadlineInPast);
            });

            it("register and withdraw in one relayed transaction without Carol paying any gas", async () => {
                const dl = deadline(3600);
                const registration = await session.prepareRelayedRegistration({ deadline: dl });
                const params = await paramsFor({ signature: registration.signature as Hex, deadline: dl });

                const receipt = await session.registerAndWithdraw(params);

                expect(receipt.status).toBe(true);
                expect(await driver.balanceOf(carol.address, driver.assets.native)).toBe(
                    need(driver, "registerAndWithdraw").drainedNativeBalance + amount(),
                );
            });

            it("leave Carol registered and the note SPENT", async () => {
                expect(await session.isKeystoreRegistered()).toBe(true);
                expect((await exported(session, note.commitment))?.status).toBe(NoteStatus.SPENT);
            });

            it("refuse register-and-withdraw for an account that is already registered", async () => {
                const params = await paramsFor({
                    signature: ("0x" + "00".repeat(65)) as Hex,
                    deadline: deadline(3600),
                });

                await expect(session.registerAndWithdraw(params)).rejects.toThrow(InvalidTransactParams);
            });
        });
    });
}
