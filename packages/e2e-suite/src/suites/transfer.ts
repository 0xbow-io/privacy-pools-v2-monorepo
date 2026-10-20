import { beforeAll, describe, expect, it } from "vitest";

import type { Hex, Note, PendingNote } from "@privacy-pools-v2/core-sdk";
import {
    bigintToHex,
    InsufficientTransactValue,
    NoteStatus,
    RecipientViewingKeyUnregistered,
} from "@privacy-pools-v2/core-sdk";

import type { ChainE2E, ChainE2EDriver, ConformanceSession, E2EActor } from "../internal.js";
import { amountOf, describeSuite, describeWith, discoverNotesWithRetry, exportedNote, need } from "../internal.js";

/**
 * Private transfer ladders (matrix §8): a transfer moves value between shielded notes without touching
 * a public balance. Delivery is the interesting part — a recipient is only discoverable on-chain if
 * they published a viewing key; otherwise the secrets must travel out of band.
 */
export function transferSuite(chain: ChainE2E): void {
    describeSuite(chain, "transfer", [], (getDriver) => {
        let driver: ChainE2EDriver;
        let fromBlock: Hex;
        let alice: E2EActor;
        let bob: E2EActor;
        let carol: E2EActor;
        let aliceSession: ConformanceSession;
        let bobSession: ConformanceSession;
        let noteX: Awaited<ReturnType<ConformanceSession["prepareDeposit"]>>["pendingNote"];

        // Alice's source note is 30 units; each transfer sends 10.
        const noteXValue = () => amountOf(driver.assets.native, 30);
        const send = () => amountOf(driver.assets.native, 10);
        const exported = exportedNote;

        beforeAll(async () => {
            driver = await getDriver();
            fromBlock = await driver.currentBlock();
            alice = await driver.createActor("alice");
            bob = await driver.createActor("bob");
            // Carol has gas but has never touched the protocol: no viewing key, no keystore.
            carol = await driver.createActor("carol");
            aliceSession = await driver.sessions.selfSubmit(alice);
            bobSession = await driver.sessions.selfSubmit(bob);
            await aliceSession.registerKeystore();
            await bobSession.registerKeystore();
            const deposit = await aliceSession.prepareDeposit({
                tokenId: driver.assets.native.id,
                value: noteXValue(),
            });
            await aliceSession.executeDeposit(deposit);
            noteX = deposit.pendingNote;
            await driver.asp.approveLabel(noteX.label);
            await driver.settleFinality();
            await aliceSession.discoverNotes({ fromBlock });
        });

        it("start with Alice's source note ACTIVE", async () => {
            expect((await exported(aliceSession, noteX.commitment))?.status).toBe(NoteStatus.ACTIVE);
        });

        it("refuse an amount above the note's value with InsufficientTransactValue", async () => {
            await expect(
                aliceSession.transfer({
                    tokenId: driver.assets.native.id,
                    amount: bigintToHex(BigInt(noteXValue()) + 1n),
                    inputCommitments: [noteX.commitment],
                    recipientDiscoveryData: { evmAddress: bob.address },
                }),
            ).rejects.toThrow(InsufficientTransactValue);
        });

        it("refuse a recipient with no on-chain viewing key with RecipientViewingKeyUnregistered", async () => {
            // Sending anyway would publish nothing the recipient could find, and the caller would have
            // discarded the only copy of the note's secrets. The SDK makes that an explicit opt-in.
            await expect(
                aliceSession.transfer({
                    tokenId: driver.assets.native.id,
                    amount: send(),
                    inputCommitments: [noteX.commitment],
                    recipientDiscoveryData: { evmAddress: carol.address },
                }),
            ).rejects.toThrow(RecipientViewingKeyUnregistered);
        });

        describe("to a registered recipient", () => {
            let received: Note<string>;

            it("send value to Bob and keep the change in a new ACTIVE note", async () => {
                const result = await aliceSession.transfer({
                    tokenId: driver.assets.native.id,
                    amount: send(),
                    inputCommitments: [noteX.commitment],
                    recipientDiscoveryData: { evmAddress: bob.address },
                });

                expect(result.txReceipt.status).toBe(true);
                const notes = (await aliceSession.exportAccount()).notes;
                const change = notes.find(
                    (n) =>
                        n.status === NoteStatus.ACTIVE &&
                        n.commitment !== noteX.commitment &&
                        n.value === bigintToHex(BigInt(noteXValue()) - BigInt(send())),
                );
                expect(change).toBeDefined();
                expect((await exported(aliceSession, noteX.commitment))?.status).toBe(NoteStatus.SPENT);
            });

            it("let Bob discover the note with his own keys from a fresh session", async () => {
                const fresh = await driver.sessions.selfSubmit(bob);

                const discovered = await discoverNotesWithRetry(driver, fresh, fromBlock);

                expect(discovered).toHaveLength(1);
                received = discovered[0]!;
                expect(received.value).toBe(send());
                expect(received.status).toBe(NoteStatus.ACTIVE);
            });

            it("let Bob spend the note he received", async () => {
                await discoverNotesWithRetry(driver, bobSession, fromBlock);
                const before = await driver.balanceOf(bob.address, driver.assets.native);

                const receipt = await bobSession.withdraw({
                    tokenId: driver.assets.native.id,
                    amount: send(),
                    recipientAddress: bob.address,
                    processorAddress: bob.address,
                    inputCommitments: [received.commitment],
                });

                expect(receipt.status).toBe(true);
                const gained = (await driver.balanceOf(bob.address, driver.assets.native)) - before;
                expect(gained).toBeGreaterThan(BigInt(send()) - driver.feeCeiling);
            });
        });

        describeWith(chain, ["relayer"], "relayed through a relayer (gasless)", () => {
            let dave: E2EActor;
            let daveSession: ConformanceSession;
            let source: PendingNote<string>;

            beforeAll(async () => {
                dave = await driver.createActor("dave-relayed");
                daveSession = await need(driver, "relayer").relayedSession(dave);
                await daveSession.registerKeystore();
                const deposit = await daveSession.prepareDeposit({ tokenId: driver.assets.native.id, value: noteXValue() });
                await daveSession.executeDeposit(deposit);
                source = deposit.pendingNote;
                await driver.asp.approveLabel(source.label);
                await driver.settleFinality();
                await daveSession.discoverNotes({ fromBlock });
            });

            it("send value to Bob through the relayer, its fee the only value that leaves the pool", async () => {
                const prepared = await daveSession.prepareTransfer({
                    tokenId: driver.assets.native.id,
                    amount: send(),
                    inputCommitments: [source.commitment],
                    recipientDiscoveryData: { evmAddress: bob.address },
                });
                expect(prepared.relayOptions.length).toBeGreaterThan(0);
                const option = prepared.relayOptions[0]!;
                const fee = BigInt(option.selectedQuote.quote.feeAmount);
                expect(fee).toBeGreaterThan(0n);

                const result = await daveSession.relayTransfer(option);

                expect(result.txReceipt.status).toBe(true);
                expect(result.spentNullifiersConfirmed).toBe(true);
                expect(result.recipientNotes?.map((n) => n.value)).toEqual([send()]);
                const change = (await daveSession.exportAccount()).notes.find(
                    (n) =>
                        n.status === NoteStatus.ACTIVE &&
                        n.value === bigintToHex(BigInt(noteXValue()) - BigInt(send()) - fee),
                );
                expect(change).toBeDefined();
                expect((await exported(daveSession, source.commitment))?.status).toBe(NoteStatus.SPENT);
            });
        });

        describe("to a recipient with no viewing key (out of band)", () => {
            let secrets: Note<string>;
            let txHash: Hex;
            let carolSession: ConformanceSession;

            beforeAll(async () => {
                carolSession = await driver.sessions.selfSubmit(carol);
            });

            it("send after explicitly opting into out-of-band delivery, and receive the note's secrets back", async () => {
                const result = await aliceSession.transfer({
                    tokenId: driver.assets.native.id,
                    amount: send(),
                    inputCommitments: [
                        (await aliceSession.exportAccount()).notes.find((n) => n.status === NoteStatus.ACTIVE)!
                            .commitment,
                    ],
                    recipientDiscoveryData: { evmAddress: carol.address, allowOutOfBandFallback: true },
                });

                expect(result.txReceipt.status).toBe(true);
                expect(result.recipientNotes).toHaveLength(1);
                secrets = result.recipientNotes![0]!;
                txHash = result.txReceipt.txHash;
                expect(secrets.noteSecret).toBeDefined();
                expect(secrets.ownerAddress).toBe(carol.address);
            });

            it("leave Carol unable to find the note by scanning, since nothing was published for her", async () => {
                const discovered = await discoverNotesWithRetry(driver, carolSession, fromBlock);

                expect(discovered.find((n) => n.commitment === secrets.commitment)).toBeUndefined();
            });

            it("import the secrets Carol was given and see the note ACTIVE", async () => {
                await carolSession.addNotes([
                    { pendingNote: { ...secrets, isOwned: true } as PendingNote<string>, txHash },
                ]);
                await driver.settleFinality();
                await carolSession.discoverNotes({ fromBlock });

                expect((await exported(carolSession, secrets.commitment))?.status).toBe(NoteStatus.ACTIVE);
            });

            it("let Carol spend it only after she registers", async () => {
                await driver.fund(carol.address);
                await carolSession.registerKeystore();
                const before = await driver.balanceOf(carol.address, driver.assets.native);

                const receipt = await carolSession.withdraw({
                    tokenId: driver.assets.native.id,
                    amount: send(),
                    recipientAddress: carol.address,
                    processorAddress: carol.address,
                    inputCommitments: [secrets.commitment],
                });

                expect(receipt.status).toBe(true);
                expect((await driver.balanceOf(carol.address, driver.assets.native)) - before).toBeGreaterThan(
                    BigInt(send()) - driver.feeCeiling,
                );
            });
        });
    });
}
