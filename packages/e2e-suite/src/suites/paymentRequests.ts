import { beforeAll, describe, expect, it } from "vitest";

import type { Hex, PaymentRequest } from "@privacy-pools-v2/core-sdk";
import {
    bigintToHex,
    InvalidPaymentRequestParams,
    KeystoreNotRegistered,
    NoteStatus,
    PaymentRequestExpired,
} from "@privacy-pools-v2/core-sdk";

import type { ChainE2E, ChainE2EDriver, ConformanceSession, E2EActor } from "../internal.js";
import { amountOf, describeSuite, discoverNotesWithRetry } from "../internal.js";

/**
 * Payment-request ladders (matrix §8): the recipient publishes a request (a fresh payment key, a tag and
 * pre-committed note slots); anyone can pay it without learning the recipient's address. The recipient
 * needs neither registration nor gas to RECEIVE, and finds the payment by its tag — but only a session
 * that still holds the request's local state can do so.
 */
export function paymentRequestsSuite(chain: ChainE2E): void {
    describeSuite(chain, "payment requests", ["paymentRequests"], (getDriver) => {
        let driver: ChainE2EDriver;
        let fromBlock: Hex;
        let alice: E2EActor;
        let bob: E2EActor;
        let aliceSession: ConformanceSession;
        let bobSession: ConformanceSession;
        let noteX: Awaited<ReturnType<ConformanceSession["prepareDeposit"]>>["pendingNote"];
        let request: PaymentRequest;
        let stateBeforePayment: Awaited<ReturnType<ConformanceSession["exportAccount"]>>;

        // Alice's note is 30 units; Bob asks for 10.
        const source = () => amountOf(driver.assets.native, 30);
        const requested = () => amountOf(driver.assets.native, 10);

        beforeAll(async () => {
            driver = await getDriver();
            fromBlock = await driver.currentBlock();
            alice = await driver.createActor("alice");
            // Unregistered and holding no gas at all: neither is needed to receive.
            bob = await driver.createActor("bob", { funded: false });
            aliceSession = await driver.sessions.selfSubmit(alice);
            bobSession = await driver.sessions.selfSubmit(bob);
            await aliceSession.registerKeystore();
            const deposit = await aliceSession.prepareDeposit({
                tokenId: driver.assets.native.id as Hex,
                value: source(),
            });
            await aliceSession.executeDeposit(deposit);
            noteX = deposit.pendingNote;
            await driver.asp.approveLabel(noteX.label);
            await driver.settleFinality();
            await aliceSession.discoverNotes({ fromBlock });
        });

        describe("creating a request", () => {
            it("refuse a malformed token address with InvalidPaymentRequestParams", async () => {
                await expect(
                    bobSession.generatePaymentRequest({ amount: requested(), tokenId: "0x1234" as never }),
                ).rejects.toThrow(InvalidPaymentRequestParams);
            });

            // KNOWN GAP, pinned with `it.fails` so it flips when fixed: a request for nothing is accepted
            // (with the default five slots), although fulfilling it could never produce a useful payment.
            it.fails("refuse a zero amount with InvalidPaymentRequestParams", async () => {
                await expect(
                    bobSession.generatePaymentRequest({ amount: "0x0" as Hex, tokenId: driver.assets.native.id as Hex }),
                ).rejects.toThrow(InvalidPaymentRequestParams);
            });

            it("reserve five note slots by default and honour a smaller count", async () => {
                const single = await bobSession.generatePaymentRequest({
                    amount: requested(),
                    tokenId: driver.assets.native.id as Hex,
                    slots: 1,
                });
                request = await bobSession.generatePaymentRequest({
                    amount: requested(),
                    tokenId: driver.assets.native.id as Hex,
                });

                expect(single.noteAddressHashes).toHaveLength(1);
                expect(request.noteAddressHashes).toHaveLength(5);
            });

            it("stamp an expiry that lies in the future", () => {
                expect(BigInt(request.expiresAt!)).toBeGreaterThan(BigInt(Date.now()));
            });
        });

        describe("paying it", () => {
            it("refuse to pay a request that has expired with PaymentRequestExpired, before spending anything", async () => {
                // The payer checks the payload's own stamp, which is what a shared QR/link carries.
                const lapsed = { ...request, expiresAt: bigintToHex(BigInt(Date.now()) - 1_000n) };

                await expect(
                    aliceSession.prepareFulfillPaymentRequest({
                        paymentRequest: lapsed,
                        inputCommitments: [noteX.commitment],
                    }),
                ).rejects.toThrow(PaymentRequestExpired);
            });

            it("pay a live request", async () => {
                stateBeforePayment = await bobSession.exportAccount();
                const prepared = await aliceSession.prepareFulfillPaymentRequest({
                    paymentRequest: request,
                    inputCommitments: [noteX.commitment],
                });

                const result = await aliceSession.executeTransfer(prepared.executeOptions);

                expect(result.txReceipt.status).toBe(true);
            });
        });

        describe("receiving it", () => {
            let received: { commitment: Hex; value: Hex };

            it("find the payment by its tag from the session that made the request, with no registration and no gas", async () => {
                expect(await bobSession.isKeystoreRegistered()).toBe(false);
                expect(await driver.balanceOf(bob.address, driver.assets.native)).toBe(0n);

                const discovered = await discoverNotesWithRetry(driver, bobSession, fromBlock);

                expect(discovered).toHaveLength(1);
                received = discovered[0]!;
                expect(received.value).toBe(requested());
                expect(discovered[0]!.status).toBe(NoteStatus.ACTIVE);
                expect(discovered[0]!.ownerAddress).toBe(bob.address);
            });

            it("find nothing from a fresh session, which has no record of the request", async () => {
                const fresh = await driver.sessions.selfSubmit(bob);

                expect(await discoverNotesWithRetry(driver, fresh, fromBlock)).toHaveLength(0);
            });

            it("find it again from a session restored from an export taken before the payment", async () => {
                const restored = await driver.sessions.selfSubmit(bob);
                await restored.importAccount(stateBeforePayment);

                const discovered = await discoverNotesWithRetry(driver, restored, fromBlock);

                expect(discovered.map((n) => n.commitment)).toEqual([received.commitment]);
            });
        });

        describe("spending what was received", () => {
            it("refuse to spend before registering with KeystoreNotRegistered", async () => {
                const note = (await bobSession.exportAccount()).notes[0]!;

                await expect(
                    bobSession.withdraw({
                        tokenId: driver.assets.native.id as Hex,
                        amount: note.value,
                        recipientAddress: bob.address,
                        processorAddress: bob.address,
                        inputCommitments: [note.commitment],
                    }),
                ).rejects.toThrow(KeystoreNotRegistered);
            });

            it("spend it once Bob registers and has gas", async () => {
                const note = (await bobSession.exportAccount()).notes[0]!;
                await driver.fund(bob.address);
                await bobSession.registerKeystore();
                const before = await driver.balanceOf(bob.address, driver.assets.native);

                const receipt = await bobSession.withdraw({
                    tokenId: driver.assets.native.id as Hex,
                    amount: note.value,
                    recipientAddress: bob.address,
                    processorAddress: bob.address,
                    inputCommitments: [note.commitment],
                });

                expect(receipt.status).toBe(true);
                expect((await driver.balanceOf(bob.address, driver.assets.native)) - before).toBeGreaterThan(
                    BigInt(requested()) - driver.feeCeiling,
                );
            });
        });
    });
}
