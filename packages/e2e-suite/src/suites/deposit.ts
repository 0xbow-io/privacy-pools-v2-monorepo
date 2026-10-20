import { beforeAll, describe, expect, it } from "vitest";

import type { Hex } from "@privacy-pools-v2/core-sdk";
import {
    AssetNotEnabled,
    BelowMinimumAmount,
    bigintToHex,
    DepositRecipientViewingKeyUnregistered,
    InvalidDepositParams,
    NoteStatus,
    WalletSendTransactionFailed,
} from "@privacy-pools-v2/core-sdk";

import type { ChainE2E, ChainE2EDriver, ConformanceSession, E2EActor } from "../internal.js";
import {
    amountOf,
    describeSuite,
    describeWith,
    discoverNotesWithRetry,
    exportedNote,
    need,
} from "../internal.js";

/**
 * Deposit ladders (matrix §4a/§4b): call it in the worst state, assert the specific failure, satisfy
 * one requirement, retry. A deposit needs no registered keystore — that is only required to spend.
 *
 * Token-allowance and prepared-transaction integrity ladders are chain mechanics (ERC-20 approvals) and
 * live with the chain SDK, not here.
 */
export function depositSuite(chain: ChainE2E): void {
    describeSuite(chain, "deposit", [], (getDriver) => {
        let driver: ChainE2EDriver;
        let fromBlock: Hex;

        // A normal-size deposit is 10 units of the asset.
        const depositValue = () => amountOf(driver.assets.native, 10);
        const tokenValue = () => amountOf(need(driver, "token").tokenAsset, 30);

        beforeAll(async () => {
            driver = await getDriver();
            fromBlock = await driver.currentBlock();
        });

        describe("parameter and asset validation (no funds needed)", () => {
            let alice: E2EActor;
            let session: ConformanceSession;

            beforeAll(async () => {
                alice = await driver.createActor("alice");
                session = await driver.sessions.selfSubmit(alice);
            });

            it("reject a malformed value with InvalidDepositParams", async () => {
                await expect(
                    session.prepareDeposit({ tokenId: driver.assets.native.id, value: "not-hex" as Hex }),
                ).rejects.toThrow(InvalidDepositParams);
            });

            it("reject a malformed token address with InvalidDepositParams", async () => {
                await expect(session.prepareDeposit({ tokenId: "0x1234", value: depositValue() })).rejects.toThrow(
                    InvalidDepositParams,
                );
            });

            it("reject an asset the Entrypoint has not enabled with AssetNotEnabled", async () => {
                await expect(
                    session.prepareDeposit({ tokenId: driver.unlistedAssetId(), value: depositValue() }),
                ).rejects.toThrow(AssetNotEnabled);
            });

            it("reject a value below the asset minimum with BelowMinimumAmount", async () => {
                await expect(
                    session.prepareDeposit({
                        tokenId: driver.assets.native.id,
                        value: bigintToHex(driver.assets.native.minDeposit - 1n),
                    }),
                ).rejects.toThrow(BelowMinimumAmount);
            });
        });

        describe("native deposit", () => {
            let dave: E2EActor;
            let session: ConformanceSession;
            let prepared: Awaited<ReturnType<ConformanceSession["prepareDeposit"]>> | undefined;

            beforeAll(async () => {
                // Unfunded: gas money is the missing requirement the first rung exposes.
                dave = await driver.createActor("dave", { funded: false });
                session = await driver.sessions.selfSubmit(dave);
            });

            it("refuse a deposit from an account that cannot pay for it, and persist no note", async () => {
                // Where the refusal surfaces is chain-specific: EVM's prepare is gas-estimation-only,
                // so it succeeds here and the missing funds only surface at submission (the second
                // half of this rung). Soroban's simulate executes the real transfer, so an unfunded
                // account fails right here instead — there's nothing to submit. Either way it's the
                // same WalletSendTransactionFailed every chain's wallet interactor throws for a real
                // send failure (Stellar's SorobanRPCInteractor.buildTransaction re-throws its
                // simulate-time rejection as this same error, precisely so callers don't have to
                // special-case which stage caught it).
                try {
                    prepared = await session.prepareDeposit({
                        tokenId: driver.assets.native.id,
                        value: depositValue(),
                    });
                } catch (error) {
                    expect(error).toBeInstanceOf(WalletSendTransactionFailed);
                    // dave is a fresh actor with no prior deposits, so "no notes at all" is as
                    // precise an assertion as "no note for this attempt" — prepare never returned
                    // a commitment to check individually.
                    expect((await session.exportAccount()).notes).toHaveLength(0);
                    return;
                }

                expect(prepared.approvalTx).toBeNull();
                expect(prepared.pendingNote.value).toBe(depositValue());

                // Reaching here means prepare succeeded — i.e. this chain behaves like EVM for this
                // rung — so the failure mode at execute is the same submission-rejection every
                // chain's wallet interactor throws for a real send failure, not something chain-variable.
                await expect(session.executeDeposit(prepared)).rejects.toThrow(WalletSendTransactionFailed);
                expect(await exportedNote(session, prepared.pendingNote.commitment)).toBeUndefined();
            });

            it("submit the same prepared deposit once the account is funded", async () => {
                await driver.fund(dave.address);
                // On a chain where the previous rung's prepare itself failed (nothing to reuse),
                // build a fresh one now that funds are in place — same as any first-time caller would.
                prepared ??= await session.prepareDeposit({
                    tokenId: driver.assets.native.id,
                    value: depositValue(),
                });
                const before = await driver.balanceOf(dave.address, driver.assets.native);

                const receipt = await session.executeDeposit(prepared);

                expect(receipt.status).toBe(true);
                const spent = before - (await driver.balanceOf(dave.address, driver.assets.native));
                expect(spent).toBeGreaterThanOrEqual(BigInt(depositValue()));
                expect(spent).toBeLessThan(BigInt(depositValue()) + driver.feeCeiling);
            });

            it("record the deposit locally as PENDING", async () => {
                const note = await exportedNote(session, prepared!.pendingNote.commitment);

                expect(note?.status).toBe(NoteStatus.PENDING);
                expect(note?.value).toBe(depositValue());
            });

            it("discover the deposit from a fresh session without any keystore registration", async () => {
                const fresh = await driver.sessions.selfSubmit(dave);
                expect(await fresh.isKeystoreRegistered()).toBe(false);

                const discovered = await discoverNotesWithRetry(driver, fresh, fromBlock);

                const found = discovered.find((n) => n.commitment === prepared!.pendingNote.commitment);
                expect(found?.value).toBe(depositValue());
                expect(found?.status).toBe(NoteStatus.PENDING);
            });

            it("accept a deposit of exactly the asset minimum", async () => {
                const minter = await driver.createActor("minter");
                const minSession = await driver.sessions.selfSubmit(minter);
                const minimum = bigintToHex(driver.assets.native.minDeposit);

                const minPrepared = await minSession.prepareDeposit({
                    tokenId: driver.assets.native.id,
                    value: minimum,
                });
                const receipt = await minSession.executeDeposit(minPrepared);

                expect(receipt.status).toBe(true);
                expect(minPrepared.pendingNote.value).toBe(minimum);
            });
        });

        describeWith(chain, "token", "token deposit: funds", () => {
            let carol: E2EActor;
            let session: ConformanceSession;
            let prepared: Awaited<ReturnType<ConformanceSession["prepareDeposit"]>> | undefined;

            beforeAll(async () => {
                // Has gas, but no tokens: the token balance is the missing requirement.
                carol = await driver.createActor("carol");
                session = await driver.sessions.selfSubmit(carol);
            });

            it("refuse a token deposit the account cannot hold, and persist no note", async () => {
                // Same chain-specific split as the native-deposit rung above: EVM's prepare succeeds
                // and the missing token balance surfaces at submission; Soroban's simulate executes
                // the real transfer (and, for a SAC-wrapped asset, the recipient's trustline check),
                // so an account holding none of the token fails right here instead — as the same
                // WalletSendTransactionFailed either way (see the native-deposit rung's comment).
                try {
                    prepared = await session.prepareDeposit({
                        tokenId: need(driver, "token").tokenAsset.id,
                        value: tokenValue(),
                    });
                } catch (error) {
                    expect(error).toBeInstanceOf(WalletSendTransactionFailed);
                    // carol is a fresh actor with no prior deposits, so "no notes at all" is as
                    // precise an assertion as "no note for this attempt" — prepare never returned
                    // a commitment to check individually.
                    expect((await session.exportAccount()).notes).toHaveLength(0);
                    return;
                }

                expect(prepared.pendingNote.value).toBe(tokenValue());

                // Reaching here means prepare succeeded — i.e. this chain behaves like EVM for this
                // rung — so the failure mode at execute is the same submission-rejection every
                // chain's wallet interactor throws for a real send failure, not something chain-variable.
                await expect(session.executeDeposit(prepared)).rejects.toThrow(WalletSendTransactionFailed);
                expect(await exportedNote(session, prepared.pendingNote.commitment)).toBeUndefined();
            });

            it("deposit the same prepared result once the account holds the tokens", async () => {
                const tokens = need(driver, "token");
                const token = tokens.tokenAsset;
                await tokens.mint(carol, token, BigInt(tokenValue()));
                // On a chain where the previous rung's prepare itself failed (nothing to reuse),
                // build a fresh one now that the account holds the token — same as any first-time
                // caller would.
                prepared ??= await session.prepareDeposit({
                    tokenId: token.id,
                    value: tokenValue(),
                });
                const before = await driver.balanceOf(carol.address, token);
                const poolBefore = await driver.balanceOf(driver.poolAddress, token);

                const receipt = await session.executeDeposit(prepared);

                expect(receipt.status).toBe(true);
                expect(before - (await driver.balanceOf(carol.address, token))).toBe(BigInt(tokenValue()));
                expect((await driver.balanceOf(driver.poolAddress, token)) - poolBefore).toBe(BigInt(tokenValue()));
            });

            it("record the token deposit locally as PENDING", async () => {
                expect((await exportedNote(session, prepared!.pendingNote.commitment))?.status).toBe(
                    NoteStatus.PENDING,
                );
            });
        });

        describe("depositFor another account", () => {
            let alice: E2EActor;
            let bob: E2EActor;
            let eve: E2EActor;
            let aliceSession: ConformanceSession;
            let bobSession: ConformanceSession;

            beforeAll(async () => {
                alice = await driver.createActor("alice-for");
                bob = await driver.createActor("bob");
                eve = await driver.createActor("eve");
                aliceSession = await driver.sessions.selfSubmit(alice);
                bobSession = await driver.sessions.selfSubmit(bob);
            });

            it("refuse a recipient with no on-chain viewing key with DepositRecipientViewingKeyUnregistered", async () => {
                await expect(
                    aliceSession.depositFor({
                        tokenId: driver.assets.native.id,
                        value: depositValue(),
                        discoveryData: { evmAddress: eve.address },
                    }),
                ).rejects.toThrow(DepositRecipientViewingKeyUnregistered);
            });

            it("deposit to a recipient once they have registered", async () => {
                await bobSession.registerKeystore();
                expect(await bobSession.isKeystoreRegistered()).toBe(true);

                const receipt = await aliceSession.depositFor({
                    tokenId: driver.assets.native.id,
                    value: depositValue(),
                    discoveryData: { evmAddress: bob.address },
                });

                expect(receipt.status).toBe(true);
            });

            it("let the recipient discover the note with their own keys", async () => {
                const fresh = await driver.sessions.selfSubmit(bob);

                const discovered = await discoverNotesWithRetry(driver, fresh, fromBlock);

                expect(discovered).toHaveLength(1);
                expect(discovered[0]?.value).toBe(depositValue());
                expect(discovered[0]?.status).toBe(NoteStatus.PENDING);
            });

            it("keep the depositor from discovering a note addressed to someone else", async () => {
                const fresh = await driver.sessions.selfSubmit(alice);

                const discovered = await discoverNotesWithRetry(driver, fresh, fromBlock);

                expect(discovered).toHaveLength(0);
            });
        });
    });
}
