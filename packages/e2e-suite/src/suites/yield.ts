import { beforeAll, expect, it } from "vitest";

import type { Hex, PendingNote, WithdrawalRelayerQuote } from "@privacy-pools-v2/core-sdk";
import {
    bigintToHex,
    FeeCommitmentExpired,
    InvalidTransactParams,
    InvalidYieldAddress,
    InvalidYieldAmount,
    NoteStatus,
} from "@privacy-pools-v2/core-sdk";

import type {
    CapabilityMembers,
    ChainE2E,
    ChainE2EDriver,
    ConformanceSession,
    E2EActor,
    E2EYieldAsset,
    E2EYieldSessions,
} from "../internal.js";
import { describeSuite, describeWith, exportedNote, need } from "../internal.js";

/** The two underlying kinds a chain can offer yield over, each its own capability. */
const KINDS = [
    { capability: "yieldNative", label: "native underlying", prefix: "n" },
    { capability: "yieldToken", label: "token underlying", prefix: "t" },
] as const;

type Kind = (typeof KINDS)[number];

/**
 * Yield ladders (matrix §4d/§11c): the underlying is wrapped into a yield-bearing share and the share is
 * shielded, so a yield deposit is a normal share-token deposit re-targeted at the router, and a yield
 * withdrawal is a normal transact with the router as processor, unwrapping to the underlying for the
 * recipient. Every requirement of the plain deposit/withdraw ladders applies to the share; the underlying
 * is the second asset in play.
 *
 * The whole ladder runs once per underlying kind — the chain's native coin and a non-native token — because
 * the two take different paths at both edges: a native deposit is funded with the coin itself (EVM wraps
 * `msg.value` into WETH; Stellar moves XLM through its SAC) and a native payout is the bare coin, while a
 * token needs an approval or a trustline and pays out as a token. A chain without one of the two opts out
 * of `yieldNative` or `yieldToken` with a reason.
 *
 * Chain mechanics that are not behaviour — EVM's ERC-20 approvals, for instance — stay in each chain's own
 * e2e files.
 */
export function yieldSuite(chain: ChainE2E): void {
    describeSuite(chain, "yield", ["yield"], (getDriver) => {
        let driver: ChainE2EDriver & CapabilityMembers["yield"];

        beforeAll(async () => {
            driver = need(await getDriver(), "yield");
        });

        describeWith(chain, ["yield"], "sessions", () => {
            it("expose no yield session on a session built without a yield deployment", async () => {
                const plain = await driver.sessionWithoutYield(await driver.createActor("yield-plain"));

                expect((plain as { yield?: unknown }).yield).toBeUndefined();
            });
        });

        for (const kind of KINDS) {
            yieldLadder(chain, kind, () => driver);
        }
    });
}

/** The full yield ladder for one underlying kind. */
function yieldLadder(chain: ChainE2E, kind: Kind, getDriver: () => ChainE2EDriver & CapabilityMembers["yield"]): void {
    let driver: ChainE2EDriver & CapabilityMembers["yield"];
    let asset!: E2EYieldAsset;
    let resolved = false;
    let fromBlock: Hex;
    /** The underlying a depositor is prepared to spend per shielded note. */
    let budget: bigint;
    const native = kind.capability === "yieldNative";
    const name = (actor: string) => `${kind.prefix}-${actor}`;
    const group = (title: string) => `${kind.label}: ${title}`;

    /**
     * Resolves this kind's asset on first use, from inside a group's `beforeAll`. Not a ladder-level
     * `beforeAll`: that would run even when the chain opted out of this kind (its groups are then
     * registered as explained skips), and `need` would throw for the member it rightly lacks.
     */
    const resolve = async () => {
        if (resolved) return;
        resolved = true;
        driver = getDriver();
        asset = native ? need(driver, "yieldNative").nativeYield : need(driver, "yieldToken").tokenYield;
        fromBlock = await driver.currentBlock();
        budget = 5n * asset.underlying.unit;
    };

    const statusOf = async (session: ConformanceSession, commitment: Hex) =>
        (await exportedNote(session, commitment))?.status;

    /** Sizes, prepares and submits a yield deposit of `budget`; the ASP approves its label. */
    const shield = async (actor: E2EActor, y: E2EYieldSessions): Promise<PendingNote<string>> => {
        const sized = await y.deposit.sizeSharesForBudget(budget);
        const prepared = await y.deposit.prepareYieldDeposit({
            value: sized.shares,
            maxUnderlyingIn: sized.maxUnderlyingIn,
        });
        for (const tx of [...prepared.approvalTxs, prepared.depositTx]) {
            await driver.submitPreparedTx(actor, tx);
        }
        await driver.asp.approveLabel(prepared.pendingNote.label);
        return prepared.pendingNote;
    };

    /** A self-submitting actor with a registered keystore, funded with twice the budget of underlying. */
    const fundedYieldActor = async (actor: string) => {
        const account = await driver.createActor(name(actor));
        const session = await driver.sessions.selfSubmit(account);
        await session.registerKeystore();
        await asset.fundUnderlying(account, budget * 2n);
        return { account, session, y: asset.yieldOf(session) };
    };

    describeWith(chain, ["yield", kind.capability], group("sizing"), () => {
        let y: E2EYieldSessions;

        beforeAll(async () => {
            await resolve();
            y = asset.yieldOf(await driver.sessions.selfSubmit(await driver.createActor(name("alice"))));
        });

        it("refuse a zero budget with InvalidYieldAmount", async () => {
            await expect(y.deposit.sizeSharesForBudget(0n)).rejects.toThrow(InvalidYieldAmount);
        });

        it("refuse a budget too small to cover the fixed costs with InvalidYieldAmount", async () => {
            await expect(y.deposit.sizeSharesForBudget(1n)).rejects.toThrow(InvalidYieldAmount);
        });

        it("refuse a zero share value with InvalidYieldAmount", async () => {
            await expect(y.deposit.prepareYieldDeposit({ value: 0n })).rejects.toThrow(InvalidYieldAmount);
        });

        it("size a budget into shares whose quoted price fits inside it", async () => {
            const sized = await y.deposit.sizeSharesForBudget(budget);

            expect(sized.shares).toBeGreaterThan(0n);
            expect(sized.underlyingNeeded).toBeLessThanOrEqual(budget);
            expect((await y.router.quote(sized.shares)).underlyingNeeded).toBe(sized.underlyingNeeded);
        });

        it("refuse a spend cap below the quoted price with InvalidYieldAmount", async () => {
            const sized = await y.deposit.sizeSharesForBudget(budget);

            await expect(y.deposit.prepareYieldDeposit({ value: sized.shares, maxUnderlyingIn: 1n })).rejects.toThrow(
                InvalidYieldAmount,
            );
        });
    });

    describeWith(chain, ["yield", kind.capability], group("shielding the underlying"), () => {
        let yuri: E2EActor;
        let session: ConformanceSession;
        let y: E2EYieldSessions;
        let note: PendingNote<string>;

        beforeAll(async () => {
            await resolve();
            ({ account: yuri, session, y } = await fundedYieldActor("yuri"));
        });

        it("spend no more underlying than the spend cap, and shield exactly the sized shares", async () => {
            const before = await driver.balanceOf(yuri.address, asset.underlying);
            const sized = await y.deposit.sizeSharesForBudget(budget);
            const prepared = await y.deposit.prepareYieldDeposit({
                value: sized.shares,
                maxUnderlyingIn: sized.maxUnderlyingIn,
            });
            expect(prepared.pendingNote.value).toBe(bigintToHex(sized.shares));
            expect(BigInt(prepared.pendingNote.value)).toBe(prepared.sharesValue);

            for (const tx of [...prepared.approvalTxs, prepared.depositTx]) {
                await driver.submitPreparedTx(yuri, tx);
            }
            note = prepared.pendingNote;

            const spent = before - (await driver.balanceOf(yuri.address, asset.underlying));
            // At least the quote: the rate only rises between quote and execution (interest accrues).
            expect(spent).toBeGreaterThanOrEqual(prepared.underlyingNeeded);
            if (native) {
                // The network fee comes out of the same balance as the deposit: bound it, don't pin it.
                expect(spent).toBeLessThanOrEqual(prepared.maxUnderlyingIn + asset.underlying.unit);
            } else {
                // A token pays no network fee, so the cap holds exactly — the unused part of what the
                // router took was refunded (or never pulled).
                expect(spent).toBeLessThanOrEqual(prepared.maxUnderlyingIn);
            }
        });

        it("turn the yield note ACTIVE once the ASP approves it and the session rescans", async () => {
            await driver.asp.approveLabel(note.label);
            await driver.settleFinality();
            await session.discoverNotes({ fromBlock });

            expect(await statusOf(session, note.commitment)).toBe(NoteStatus.ACTIVE);
        });

        it("value the note in the underlying at the live share rate", async () => {
            const value = await y.token.previewRedeem(BigInt(note.value));

            expect(value).toBeGreaterThan(0n);
            expect(value).toBeLessThanOrEqual(budget);
        });
    });

    describeWith(chain, ["yield", kind.capability], group("withdraw parameters"), () => {
        let alice: E2EActor;
        let y: E2EYieldSessions;
        const base = () => ({
            inputCommitments: [("0x" + "ab".repeat(32)) as Hex],
            amount: 1_000n,
            amountOut: 1_000n,
            recipient: alice.address,
        });

        beforeAll(async () => {
            await resolve();
            alice = await driver.createActor(name("alice-params"));
            y = asset.yieldOf(await driver.sessions.selfSubmit(alice));
        });

        it("refuse the empty address as recipient with InvalidYieldAddress", async () => {
            await expect(y.withdraw.prepareYieldWithdraw({ ...base(), recipient: driver.emptyAddress })).rejects.toThrow(
                InvalidYieldAddress,
            );
        });

        it("refuse a zero withdrawal amount with InvalidYieldAmount", async () => {
            await expect(y.withdraw.prepareYieldWithdraw({ ...base(), amountOut: 0n })).rejects.toThrow(InvalidYieldAmount);
        });

        it("refuse a fee larger than the withdrawn amount with InvalidYieldAmount", async () => {
            await expect(y.withdraw.prepareYieldWithdraw({ ...base(), feeAmount: 2_000n })).rejects.toThrow(
                InvalidYieldAmount,
            );
        });

        it("refuse a slippage tolerance above 100% with InvalidYieldAmount", async () => {
            await expect(y.withdraw.prepareYieldWithdraw({ ...base(), slippageBps: 10_001n })).rejects.toThrow(
                InvalidYieldAmount,
            );
        });
    });

    describeWith(chain, ["yield", kind.capability], group("withdrawing shares to the underlying"), () => {
        let yara: E2EActor;
        let dest: E2EActor;
        let session: ConformanceSession;
        let y: E2EYieldSessions;
        let selfNote: PendingNote<string>;
        const fullWithdraw = (recipient: string) =>
            y.withdraw.prepareYieldWithdraw({
                inputCommitments: [selfNote.commitment],
                amount: BigInt(selfNote.value),
                amountOut: BigInt(selfNote.value),
                recipient,
            });

        beforeAll(async () => {
            await resolve();
            ({ account: yara, session, y } = await fundedYieldActor("yara"));
            dest = await driver.createActor(name("yara-dest"));
            // Whatever the recipient needs to be able to hold the underlying (a Stellar trustline).
            await asset.fundUnderlying(dest, 0n);
            selfNote = await shield(yara, y);
            await driver.settleFinality();
            await session.discoverNotes({ fromBlock });
        });

        it("start with the shielded note ACTIVE", async () => {
            expect(await statusOf(session, selfNote.commitment)).toBe(NoteStatus.ACTIVE);
        });

        it("fail a withdrawal to a recipient that cannot receive the underlying, leaving the note spendable", async (ctx) => {
            // e.g. a contract that rejects ETH, a Stellar account without a trustline or that does not
            // exist. Chains where every address can receive this asset have nothing to test here.
            if (!asset.unreceivableRecipient) return ctx.skip();
            const recipient = await asset.unreceivableRecipient();

            // Where it fails is the chain's business: EVM reverts on submission, while Stellar's SDK
            // simulates while preparing and refuses there. Either way nothing may be spent.
            await expect(
                (async () => {
                    const prepared = await fullWithdraw(recipient);
                    await driver.submitPreparedTx(yara, prepared.withdrawTx);
                })(),
            ).rejects.toThrow();

            await driver.settleFinality();
            await session.discoverNotes({ fromBlock });
            expect(await statusOf(session, selfNote.commitment)).toBe(NoteStatus.ACTIVE);
        });

        it("hand the recipient the quoted underlying, within the slippage band, when the account submits the withdrawal itself", async () => {
            const prepared = await fullWithdraw(dest.address);
            expect(prepared.quotedUnderlyingOut).toBeGreaterThan(0n);
            // The recipient's floor sits below the quote by the slippage tolerance.
            expect(prepared.minUnderlyingOut).toBeLessThan(prepared.quotedUnderlyingOut);

            const before = await driver.balanceOf(dest.address, asset.underlying);
            await driver.submitPreparedTx(yara, prepared.withdrawTx);

            // Not exactly the quote: the share rate keeps moving between quote and execution on any
            // reserve with borrowers (one stroop of interest was enough to break an exact check on the
            // local Blend pool). The contract pays at the execution rate with the floor as its guard, so
            // the payout lies within the slippage band around the quote.
            const received = (await driver.balanceOf(dest.address, asset.underlying)) - before;
            const band = prepared.quotedUnderlyingOut - prepared.minUnderlyingOut;
            expect(received).toBeGreaterThanOrEqual(prepared.minUnderlyingOut);
            expect(received).toBeLessThanOrEqual(prepared.quotedUnderlyingOut + band);
        });

        it("see the spent note SPENT after finality and a rescan", async () => {
            await driver.settleFinality();
            await session.discoverNotes({ fromBlock });

            expect(await statusOf(session, selfNote.commitment)).toBe(NoteStatus.SPENT);
        });
    });

    describeWith(chain, ["yield", kind.capability, "relayer"], group("withdrawing shares through the relayer"), () => {
        let dest: E2EActor;
        let session: ConformanceSession;
        let y: E2EYieldSessions;
        let note: PendingNote<string>;
        let quote: WithdrawalRelayerQuote<string>;
        const relayParams = (overrides: Record<string, unknown> = {}) => ({
            inputCommitments: [note.commitment],
            amount: BigInt(quote.amountSent),
            amountOut: BigInt(quote.amountSent),
            recipient: dest.address,
            signedFeeCommitment: quote.feeCommitment,
            ...overrides,
        });

        beforeAll(async () => {
            await resolve();
            let yves: E2EActor;
            ({ account: yves, session, y } = await fundedYieldActor("yves"));
            dest = await driver.createActor(name("yves-dest"));
            // Whatever the recipient needs to be able to hold the underlying (a Stellar trustline).
            await asset.fundUnderlying(dest, 0n);
            note = await shield(yves, y);
            await driver.settleFinality();
            await session.discoverNotes({ fromBlock });
            quote = await asset.withdrawalQuote({
                recipient: dest.address,
                amount: (BigInt(note.value) * 9n) / 10n,
            });
        });

        it("refuse a commitment whose expiry has passed with FeeCommitmentExpired", async () => {
            const lapsed = { ...quote.feeCommitment, expiration: Date.now() - 1_000 };

            await expect(
                y.withdraw.prepareYieldWithdrawRelay(relayParams({ signedFeeCommitment: lapsed }) as never),
            ).rejects.toThrow(FeeCommitmentExpired);
        });

        it("refuse a commitment signed for a different asset with InvalidTransactParams", async () => {
            const wrongAsset = { ...quote.feeCommitment, asset: asset.underlying.id };

            await expect(
                y.withdraw.prepareYieldWithdrawRelay(relayParams({ signedFeeCommitment: wrongAsset }) as never),
            ).rejects.toThrow(InvalidTransactParams);
        });

        it("refuse an amount that differs from what the relayer signed for, with InvalidTransactParams", async () => {
            const off = BigInt(quote.amountSent) - 1n;

            await expect(y.withdraw.prepareYieldWithdrawRelay(relayParams({ amountOut: off }) as never)).rejects.toThrow(
                InvalidTransactParams,
            );
        });

        it("deliver at least the guaranteed underlying when the relayer submits the withdrawal", async () => {
            const prepared = await y.withdraw.prepareYieldWithdrawRelay(relayParams() as never);
            const before = await driver.balanceOf(dest.address, asset.underlying);

            await asset.relayWithdrawal(prepared.relayParams);

            expect((await driver.balanceOf(dest.address, asset.underlying)) - before).toBeGreaterThanOrEqual(
                prepared.minUnderlyingOut,
            );
        });

        it("see the relayed note SPENT after finality and a rescan", async () => {
            await driver.settleFinality();
            await session.discoverNotes({ fromBlock });

            expect(await statusOf(session, note.commitment)).toBe(NoteStatus.SPENT);
        });
    });
}
