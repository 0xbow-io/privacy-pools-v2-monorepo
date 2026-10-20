import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Hex } from "@privacy-pools-v2/core-sdk";
import {
    bigintToHex,
    FeeCommitmentExpired,
    HTTPClient,
    InvalidTransactParams,
    NoteStatus,
    RelayerRejected,
    RelayerRequestFailed,
} from "@privacy-pools-v2/core-sdk";

import type { CapabilityMembers, ChainE2E, ChainE2EDriver, ConformanceSession, E2EActor } from "../internal.js";
import {
    amountOf,
    describeSuite,
    describeWith,
    discoverNotesWithRetry,
    exportedNote,
    need,
    RelayerProxy,
    setExpiration,
} from "../internal.js";

type PendingNote = Awaited<ReturnType<ConformanceSession["prepareDeposit"]>>["pendingNote"];

const BATCH_QUOTE = /\/v1\/quote\/.*\/batch$/;
const WITHDRAW_QUOTE = /\/v1\/quote\/.*\/receive$/;
const WITHDRAW_RELAY = /\/v1\/relay\/.*\/withdrawal$/;

/** The parts of a relayer withdrawal quote these rungs tamper with; the rest passes through untouched. */
interface QuoteJson {
    amountSent: string;
    feeCommitment: { expiration: number; data: string; amountSent: string };
}

/**
 * Relayer-side faults: the relayer is an outside service the SDK must not trust. A fault-injecting proxy
 * sits in front of the real relayer and each rung makes it misbehave one way — down, erroring, hanging,
 * garbling its reply, quoting an already-lapsed commitment, signing routing that pays someone else,
 * rejecting a submission, or claiming success without submitting anything. The SDK's client-side guards
 * must catch each, and the note must stay spendable through all of it.
 */
export function relayerFaultsSuite(chain: ChainE2E): void {
    describeSuite(chain, "relayer faults", ["relayer"], (getDriver) => {
        let driver: ChainE2EDriver & CapabilityMembers["relayer"];
        let proxy: RelayerProxy;
        let alice: E2EActor;
        let dest: E2EActor;
        let session: ConformanceSession;
        let note: PendingNote;

        const noteValue = () => amountOf(driver.assets.native, 30);
        // A relayed withdrawal pays the relayer's fee out of the same note, so it asks for less than the note
        // holds. Same headroom as the withdraw suite's relayed rung.
        const amount = () => BigInt(noteValue()) - driver.assets.native.unit * 2n;

        /** Fast, no-retry client so a dead relayer fails in ~a second instead of a minute. */
        const fastClient = () => new HTTPClient({ retryAttempts: 0, timeout: 1_500 });

        /** A withdrawal quote requested THROUGH the proxy, so rewrite faults apply to it. */
        const quote = () =>
            driver.withdrawalQuote(
                { asset: driver.assets.native, recipient: dest.address, amount: amount() },
                { relayerUrl: proxy.url, httpClient: fastClient() },
            );
        const relay = async (selectedQuote: Awaited<ReturnType<typeof quote>>) =>
            session.relayWithdraw({
                inputCommitments: [note.commitment],
                amount: bigintToHex(amount()),
                tokenId: driver.assets.native.id,
                recipientAddress: dest.address,
                selectedQuote,
            });
        const noteStatus = async () => (await exportedNote(session, note.commitment))?.status;
        // Deltas, not absolute balances: an "unfunded" account is 0 on EVM but holds its reserve on Stellar.
        const destBalance = () => driver.balanceOf(dest.address, driver.assets.native);
        const rewriteQuote = (edit: (q: QuoteJson) => void) =>
            proxy.addFault({
                match: WITHDRAW_QUOTE,
                action: {
                    kind: "rewrite",
                    edit: (json) => {
                        const copy = structuredClone(json) as QuoteJson;
                        edit(copy);
                        return copy;
                    },
                },
            });

        beforeAll(async () => {
            driver = need(await getDriver(), "relayer");
            const fromBlock = await driver.currentBlock();
            proxy = await RelayerProxy.start(driver.relayerUrl);
            alice = await driver.createActor("alice");
            // A gasless destination, so what it gains is exactly what the relayer delivered.
            dest = await driver.createActor("dest", { funded: false });
            session = await driver.relayedSession(alice, { relayerUrl: proxy.url, httpClient: fastClient() });
            await session.registerKeystore();
            const prepared = await session.prepareDeposit({ tokenId: driver.assets.native.id, value: noteValue() });
            await session.executeDeposit(prepared);
            note = prepared.pendingNote;
            await driver.asp.approveLabel(note.label);
            await discoverNotesWithRetry(driver, session, fromBlock);
        });

        // A failed rung must never leave a fault behind for the next one.
        afterEach(() => proxy.clearFaults());
        afterAll(async () => {
            await proxy?.stop();
        });

        it("start with the note ACTIVE and every request going through the proxy", async () => {
            expect(await noteStatus()).toBe(NoteStatus.ACTIVE);
            await quote();
            expect(proxy.requests.some((r) => WITHDRAW_QUOTE.test(r.path))).toBe(true);
        });

        describeWith(chain, "batchRelay", "requesting a batch quote", () => {
            const askForBatch = () =>
                session.prepareBatchWithdraw({ tokenId: driver.assets.native.id, recipientAddress: dest.address });

            it("report a relayer that is not there as RelayerRequestFailed", async () => {
                proxy.addFault({ match: BATCH_QUOTE, action: { kind: "down" } });

                await expect(askForBatch()).rejects.toThrow(RelayerRequestFailed);
            });

            it("report a relayer that answers with an HTTP error as RelayerRequestFailed", async () => {
                proxy.addFault({ match: BATCH_QUOTE, action: { kind: "status", status: 500 } });

                await expect(askForBatch()).rejects.toThrow(RelayerRequestFailed);
            });

            it("report a relayer that never answers as RelayerRequestFailed once the client gives up", async () => {
                proxy.addFault({ match: BATCH_QUOTE, action: { kind: "timeout" } });

                await expect(askForBatch()).rejects.toThrow(RelayerRequestFailed);
            });

            it("report a reply that is not JSON as RelayerRequestFailed", async () => {
                proxy.addFault({ match: BATCH_QUOTE, action: { kind: "malformed" } });

                await expect(askForBatch()).rejects.toThrow(RelayerRequestFailed);
            });

            it("refuse a quote that has already expired with FeeCommitmentExpired", async () => {
                proxy.addFault({
                    match: BATCH_QUOTE,
                    action: { kind: "rewrite", edit: (json) => setExpiration(json, Date.now() - 1_000) },
                });

                await expect(askForBatch()).rejects.toThrow(FeeCommitmentExpired);
            });
        });

        describe("a withdrawal quote the SDK must not trust", () => {
            it("refuse a commitment that lapses before it is used with FeeCommitmentExpired, before proving anything", async () => {
                // A short-lived quote: valid when it arrives, expired by the time the withdrawal is built.
                rewriteQuote((q) => {
                    q.feeCommitment.expiration = Date.now() + 1_500;
                });
                const selected = await quote();
                await new Promise((resolve) => setTimeout(resolve, 2_000));

                await expect(relay(selected)).rejects.toThrow(FeeCommitmentExpired);
            });

            it("refuse signed routing that pays a different recipient with InvalidTransactParams", async () => {
                const attacker = (await driver.createActor("attacker")).address;
                rewriteQuote((q) => {
                    q.feeCommitment.data = driver.rerouteFeeCommitment(q.feeCommitment.data as Hex, attacker);
                });

                await expect(relay(await quote())).rejects.toThrow(InvalidTransactParams);
            });

            it("refuse a quote whose gross amount is not the requested amount plus its fee with InvalidTransactParams", async () => {
                // The top-level amountSent is what the proof commits to releasing from the pool, so an
                // inflated one is caught locally, before any proof is built.
                rewriteQuote((q) => {
                    q.amountSent = (BigInt(q.amountSent) + 1n).toString();
                });

                await expect(relay(await quote())).rejects.toThrow(InvalidTransactParams);
            });

            it("still hold the note ACTIVE after every refused quote", async () => {
                expect(await noteStatus()).toBe(NoteStatus.ACTIVE);
            });
        });

        describe("submitting the withdrawal", () => {
            it("report a relayer that rejects the submission as RelayerRejected and keep the note ACTIVE", async () => {
                proxy.addFault({
                    match: WITHDRAW_RELAY,
                    action: { kind: "status", status: 400, body: { message: "rejected" } },
                });

                await expect(relay(await quote())).rejects.toThrow(RelayerRejected);
                expect(await noteStatus()).toBe(NoteStatus.ACTIVE);
            });

            it("leave a mismatch inside the signed commitment to the relayer, which rejects it as RelayerRejected", async () => {
                // The SDK reads the quote's top-level amountSent, not the copy nested in feeCommitment, so this
                // inconsistency is not caught locally: a proof is built and submitted, and the relayer's own
                // signature check refuses it. Nothing is spent and the note stays ACTIVE.
                rewriteQuote((q) => {
                    q.feeCommitment.amountSent = (BigInt(q.feeCommitment.amountSent) + 1n).toString();
                });

                await expect(relay(await quote())).rejects.toThrow(RelayerRejected);
                expect(await noteStatus()).toBe(NoteStatus.ACTIVE);
            });

            it("not mark the note SPENT when the relayer answers with the hash of an unrelated transaction", async () => {
                // A relayer that lies about having submitted: the reply is a real, successful transaction that
                // never touched the pool. The SDK checks the receipt for the note's nullifier and, finding
                // none, persists nothing — the note stays spendable and discovery is the backstop.
                const unrelated = await driver.sendUnrelatedTransaction(alice);
                proxy.addFault({ match: WITHDRAW_RELAY, action: { kind: "respond", body: { txHash: unrelated } } });
                const before = await destBalance();

                const receipt = await relay(await quote());

                expect(receipt.status).toBe(true);
                expect(await noteStatus()).toBe(NoteStatus.ACTIVE);
                expect((await destBalance()) - before).toBe(0n);
            });

            it("spend the very same note once the relayer behaves", async () => {
                const before = await destBalance();

                const receipt = await relay(await quote());

                expect(receipt.status).toBe(true);
                expect((await destBalance()) - before).toBe(amount());
                expect(await noteStatus()).toBe(NoteStatus.SPENT);
            });
        });
    });
}
