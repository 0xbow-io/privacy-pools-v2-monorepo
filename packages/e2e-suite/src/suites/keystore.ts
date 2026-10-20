import { beforeAll, describe, expect, it } from "vitest";

import type { Hex } from "@privacy-pools-v2/core-sdk";
import {
    bigintToHex,
    DepositRecipientViewingKeyUnregistered,
    KeystoreAlreadyRegistered,
    KeystoreNotRegistered,
    NoteStatus,
    RegistrationDeadlineInPast,
    RevocableKeyIndexNotFound,
    UnexpectedTransactionTarget,
    WalletSendTransactionFailed,
    WitnessPreparationFailed,
} from "@privacy-pools-v2/core-sdk";

import type { ChainE2E, ChainE2EDriver, ConformanceSession, E2EActor, SignatureDerivation } from "../internal.js";
import { amountOf, describeSuite, describeWith, discoverNotesWithRetry, itWith, need } from "../internal.js";

const nowSeconds = () => Math.floor(Date.now() / 1000);
const deadlineIn = (seconds: number): Hex => bigintToHex(BigInt(nowSeconds() + seconds));

/**
 * Key registration ladders (matrix §3). Registration is what turns an address into a spender: it is
 * required to spend, never to receive. It is two transactions (`setAuthPolicy` + `setViewingKey`) and
 * is idempotent and resumable.
 */
export function keystoreSuite(chain: ChainE2E): void {
    describeSuite(chain, "keystore registration", [], (getDriver) => {
        let driver: ChainE2EDriver;
        let fromBlock: Hex;

        const noteValue = () => amountOf(driver.assets.native, 10);
        const canRotate = chain.unsupportedReason("keyRotation") === undefined;

        beforeAll(async () => {
            driver = await getDriver();
            fromBlock = await driver.currentBlock();
        });

        describe("register a new account", () => {
            let alice: E2EActor;
            let session: ConformanceSession;
            let derivation: SignatureDerivation | undefined;
            let prepared: Awaited<ReturnType<ConformanceSession["prepareRegisterKeystore"]>>;

            beforeAll(async () => {
                // Signature-derived where the chain supports it (so rotation/discovery calls are possible at
                // all) and unfunded (gas is the first missing requirement).
                alice = await driver.createActor("alice", { funded: false, signed: canRotate });
                derivation = alice.derivation;
                session = await driver.sessions.selfSubmit(alice);
            });

            it("start unregistered", async () => {
                expect(await session.isKeystoreRegistered()).toBe(false);
            });

            itWith(
                chain,
                "keyRotation",
                "refuse to rotate a key that was never registered with KeystoreNotRegistered",
                async () => {
                    await expect(session.rotateRevocableKey(derivation!)).rejects.toThrow(KeystoreNotRegistered);
                },
            );

            itWith(
                chain,
                "keyRotation",
                "refuse to discover the key index of an unregistered account with KeystoreNotRegistered",
                async () => {
                    await expect(session.discoverRevocableKeyIndex(derivation!)).rejects.toThrow(
                        KeystoreNotRegistered,
                    );
                },
            );

            it("prepare both registration transactions without spending anything", async () => {
                prepared = await session.prepareRegisterKeystore();

                expect(prepared.alreadyRegistered).toBe(false);
                expect(prepared.keystoreCalldata).not.toBeNull();
                expect(prepared.viewingKeyCalldata).not.toBeNull();
            });

            it("refuse a registration transaction aimed at a different contract before submitting anything", async () => {
                const tampered = {
                    ...prepared,
                    keystoreCalldata: driver.tamper.retarget(prepared.keystoreCalldata!),
                };

                await expect(session.executeRegisterKeystore(tampered)).rejects.toThrow(UnexpectedTransactionTarget);
                expect(await session.isKeystoreRegistered()).toBe(false);
            });

            it("fail to register from an unfunded account with WalletSendTransactionFailed", async () => {
                await expect(session.executeRegisterKeystore(prepared)).rejects.toThrow(WalletSendTransactionFailed);

                expect(await session.isKeystoreRegistered()).toBe(false);
            });

            it("register with the same prepared transactions once the account is funded", async () => {
                await driver.fund(alice.address);

                const receipts = await session.executeRegisterKeystore(prepared);

                expect(receipts).toHaveLength(2);
                expect(receipts.every((r) => r.status)).toBe(true);
                expect(await session.isKeystoreRegistered()).toBe(true);
            });

            it("publish the viewing key so senders can encrypt to this account", async () => {
                expect(BigInt(await driver.registeredViewingKey(alice.address))).toBe(
                    BigInt(alice.keys.viewingPublicKey),
                );
            });

            it("treat a second registration as a no-op that submits nothing", async () => {
                const receipts = await session.registerKeystore();

                expect(receipts).toHaveLength(0);
            });

            it("refuse to prepare a relayed registration for an account that is already registered", async () => {
                await expect(session.prepareRelayedRegistration({ deadline: deadlineIn(3600) })).rejects.toThrow(
                    KeystoreAlreadyRegistered,
                );
            });

            it("see the registration from a fresh session", async () => {
                const fresh = await driver.sessions.selfSubmit(alice);

                expect(await fresh.isKeystoreRegistered()).toBe(true);
            });
        });

        describe("resume a partial registration", () => {
            let bob: E2EActor;
            let alice: E2EActor;
            let session: ConformanceSession;
            let aliceSession: ConformanceSession;

            beforeAll(async () => {
                bob = await driver.createActor("bob");
                alice = await driver.createActor("alice-partial");
                session = await driver.sessions.selfSubmit(bob);
                aliceSession = await driver.sessions.selfSubmit(alice);
            });

            it("register only the auth policy when the viewing key is left out", async () => {
                const receipts = await session.registerKeystore({ includeViewingKey: false });

                expect(receipts).toHaveLength(1);
                expect(await session.isKeystoreRegistered()).toBe(true);
                expect(BigInt(await driver.registeredViewingKey(bob.address))).toBe(0n);
            });

            it("refuse a discoverable deposit to an account that has no viewing key yet", async () => {
                await expect(
                    aliceSession.depositFor({
                        tokenId: driver.assets.native.id,
                        value: noteValue(),
                        discoveryData: { evmAddress: bob.address },
                    }),
                ).rejects.toThrow(DepositRecipientViewingKeyUnregistered);
            });

            it("submit only the missing viewing-key transaction when resumed from a fresh session", async () => {
                const resumed = await driver.sessions.selfSubmit(bob);

                const receipts = await resumed.registerKeystore();

                expect(receipts).toHaveLength(1);
                expect(BigInt(await driver.registeredViewingKey(bob.address))).toBe(
                    BigInt(bob.keys.viewingPublicKey),
                );
            });

            it("accept a discoverable deposit once the viewing key is published", async () => {
                const receipt = await aliceSession.depositFor({
                    tokenId: driver.assets.native.id,
                    value: noteValue(),
                    discoveryData: { evmAddress: bob.address },
                });

                expect(receipt.status).toBe(true);
            });
        });

        describe("resume a partial registration in the same session", () => {
            // Regression: the resume used to submit the missing setViewingKey tx (succeeding on-chain) and
            // then throw AlreadyRegistered, because the session had already marked itself registered after
            // the first, partial run.
            it("return the viewing-key receipt and publish the viewing key", async () => {
                const zed = await driver.createActor("zed");
                const session = await driver.sessions.selfSubmit(zed);
                await session.registerKeystore({ includeViewingKey: false });

                const receipts = await session.registerKeystore();

                expect(receipts).toHaveLength(1);
                expect(BigInt(await driver.registeredViewingKey(zed.address))).toBe(
                    BigInt(zed.keys.viewingPublicKey),
                );
            });
        });

        describeWith(chain, "registerAndWithdraw", "prepare a gasless (relayed) registration", () => {
            let carol: E2EActor;
            let session: ConformanceSession;

            beforeAll(async () => {
                // Zero balance: the whole point of relayed registration is that the account pays no gas.
                carol = await driver.createActor("carol", { funded: false });
                session = await driver.sessions.selfSubmit(carol);
            });

            it("refuse a deadline that has already passed with RegistrationDeadlineInPast", async () => {
                await expect(session.prepareRelayedRegistration({ deadline: deadlineIn(-60) })).rejects.toThrow(
                    RegistrationDeadlineInPast,
                );
            });

            it("sign the registration message with the account's own key, without any gas", async () => {
                const relayed = await session.prepareRelayedRegistration({ deadline: deadlineIn(3600) });

                expect(relayed.signature).not.toBeNull();
                expect(relayed.account).toBe(carol.address);
                expect(await need(driver, "registerAndWithdraw").verifyRelayedRegistration(relayed, carol)).toBe(true);
            });

            it("leave the account unregistered and unfunded, since nothing was submitted", async () => {
                expect(await session.isKeystoreRegistered()).toBe(false);
                expect(await driver.balanceOf(carol.address, driver.assets.native)).toBe(
                    need(driver, "registerAndWithdraw").drainedNativeBalance,
                );
            });
        });

        describeWith(chain, "keyRotation", "rotate the revocable key", () => {
            let rita: E2EActor;
            let derivation: SignatureDerivation;
            let session: ConformanceSession;
            let noteCommitment: Hex;

            beforeAll(async () => {
                rita = await driver.createActor("rita", { signed: true });
                derivation = rita.derivation!;
                session = await driver.sessions.selfSubmit(rita);
                await session.registerKeystore();
            });

            it("discover index zero for a freshly registered account", async () => {
                expect(BigInt(await session.discoverRevocableKeyIndex(derivation))).toBe(0n);
            });

            it("fund a note that the rotated key must still be able to spend", async () => {
                const prepared = await session.prepareDeposit({
                    tokenId: driver.assets.native.id,
                    value: noteValue(),
                });
                await session.executeDeposit(prepared);
                noteCommitment = prepared.pendingNote.commitment;
                await driver.asp.approveLabel(prepared.pendingNote.label);
                // The depositing session already knows its own note, so this scan reports nothing new;
                // what changes is the note's status, read back from the account export.
                await driver.settleFinality();
                await session.discoverNotes({ fromBlock });
                const note = (await session.exportAccount()).notes.find((n) => n.commitment === noteCommitment);

                expect(note?.status).toBe(NoteStatus.ACTIVE);
            });

            it("rotate to index one, replacing the on-chain authorizer digest", async () => {
                const outcome = await session.rotateRevocableKey(derivation);

                expect(outcome.receipt.status).toBe(true);
                expect(outcome.newAuthorizerDigest).not.toBe(outcome.oldAuthorizerDigest);
                expect(BigInt(outcome.newRevocableKeyIndex)).toBe(1n);
                expect(BigInt(session.getRevocableKeyIndex())).toBe(1n);
            });

            it("discover index one after rotation", async () => {
                expect(BigInt(await session.discoverRevocableKeyIndex(derivation))).toBe(1n);
            });

            it("fail to discover the index when the gap limit stops short of it", async () => {
                // Only index 0 is tried, and the on-chain digest now belongs to index 1.
                await expect(session.discoverRevocableKeyIndex(derivation, 1)).rejects.toThrow(
                    RevocableKeyIndexNotFound,
                );
            });

            it("fail to spend from a session still holding the old key, without calling the account unregistered", async () => {
                // Registered on-chain, but this session's revocable key no longer matches the tree leaf:
                // that must stay a witness failure, never KeystoreNotRegistered.
                const stale = await driver.sessions.selfSubmit(rita);
                await discoverNotesWithRetry(driver, stale, fromBlock);

                const failure = await stale
                    .withdraw({
                        tokenId: driver.assets.native.id,
                        amount: noteValue(),
                        recipientAddress: rita.address,
                        processorAddress: rita.address,
                        inputCommitments: [noteCommitment],
                    })
                    .then(
                        () => undefined,
                        (error: unknown) => error,
                    );

                expect(failure).toBeInstanceOf(WitnessPreparationFailed);
                expect(failure).not.toBeInstanceOf(KeystoreNotRegistered);
            });

            it("spend under the rotated key from a session rebuilt at the discovered index", async () => {
                const index = await session.discoverRevocableKeyIndex(derivation);
                const rehydrated = await driver.sessions.selfSubmit({
                    ...rita,
                    keys: need(driver, "keyRotation").keysAtIndex(rita, index),
                });
                await discoverNotesWithRetry(driver, rehydrated, fromBlock);
                await driver.settleFinality();

                const receipt = await rehydrated.withdraw({
                    tokenId: driver.assets.native.id,
                    amount: noteValue(),
                    recipientAddress: rita.address,
                    processorAddress: rita.address,
                    inputCommitments: [noteCommitment],
                });

                expect(receipt.status).toBe(true);
            });
        });
    });
}
