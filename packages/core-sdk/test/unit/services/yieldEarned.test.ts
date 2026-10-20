import { describe, expect, it } from "vitest";

import type {
    Address,
    ComputeYieldEarnedArgs,
    EventSnapshot,
    Hash,
    Hex,
    YieldDepositFact,
    YieldEarned,
    YieldEarnedEvents,
    YieldEarnedNote,
    YieldRateSeries,
} from "../../../src/internal.js";
import {
    bigintToHex,
    computeYieldEarned,
    NoteStatus,
    yieldEarnedEventsFromSnapshot,
} from "../../../src/internal.js";

/**
 * Fixtures come from a deterministic vault model, not from hand-written "realistic" numbers:
 * the model mirrors the arithmetic the real producers use. The router mints
 * `total = value + floor(value * vettingFeeBps / 10000)` shares for a requested `value`
 * (PoolSessionYieldDeposit) and charges `ceil(total * rate / UNIT)` underlying for them (ERC-4626
 * previewMint); the ASP fact is that tuple keyed by the note's commitment; the rate feed samples
 * the model's rate on an hourly grid. Every property below is asserted across at least two
 * differing parameter sets.
 */

const SHARE = "0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6" as Address;
const SHARE_DECIMALS = 18;
const UNIT = 10n ** 18n;
const ASSET_DECIMALS = 6;
const INCEPTION = 10n ** 6n; // one underlying per whole share
const T0 = 1_757_000_000; // series start, unix seconds
const HOUR = 3600;

/** Linear rate growth: `slope` underlying-units per whole share per hour. */
interface Vault { r0: bigint; slopePerHour: bigint; feeBps: bigint }

function rateAt(vault: Vault, t: number): bigint {
    // Exact integer arithmetic in seconds so the model is monotone and deterministic.
    return vault.r0 + (vault.slopePerHour * BigInt(t - T0)) / BigInt(HOUR);
}

function series(vault: Vault, hours: number, opts: { from?: number } = {}): YieldRateSeries {
    const from = opts.from ?? T0;
    const observations = [];
    for (let i = 0; i <= hours; i++) {
        const t = from + i * HOUR;
        observations.push({
            timestamp: t,
            exchangeRate: rateAt(vault, t),
            block: BigInt(1000 + i),
        });
    }
    return {
        share: SHARE,
        shareDecimals: SHARE_DECIMALS,
        assetDecimals: ASSET_DECIMALS,
        observations,
    };
}

function ceilDiv(a: bigint, b: bigint): bigint {
    return (a + b - 1n) / b;
}

let nextId = 1;
function hex(): Hex {
    return bigintToHex(BigInt(nextId++));
}

type ModelNote = YieldEarnedNote & { fact?: YieldDepositFact };

/** A deposit of exactly `value` shares at time `t`, with the fact the indexer would emit. */
/** The zap adds this to every quoted `_underlyingIn`; see DEPOSIT_BASIS_SLACK. */
const ZAP_SUPPLY_ROUNDING_BUFFER = 2n;

function deposit(vault: Vault, value: bigint, t: number): ModelNote {
    const commitment = hex();
    const total = value + (value * vault.feeBps) / 10_000n;
    // + ZAP_SUPPLY_ROUNDING_BUFFER. The real producer is
    // PPRouter.depositExactShares -> PPYieldTokenZap.quoteBuy, which returns
    // `previewMint(total) + 2` so the supply cannot come up short, and the ASP stores that
    // `_underlyingIn` verbatim. Omitting it here is what let a fixture disagree with the
    // chain by two units and hid a same-instant valuation returning `inconsistent`.
    const gross = ceilDiv(total * rateAt(vault, t), UNIT) + ZAP_SUPPLY_ROUNDING_BUFFER;
    return {
        commitment,
        nullifier: hex(),
        shares: value,
        status: NoteStatus.ACTIVE,
        createdAt: t,
        originatedHere: true,
        fact: {
            outputCommitment: commitment,
            asset: SHARE,
            txHash: hex() as Hash,
            grossUnderlying: gross,
            noteShares: value,
            totalSharesMinted: total,
            vettingFeeShares: total - value,
            blockTimestamp: t,
        },
    };
}

/** A note some other wallet sent us (output of a transact none of our nullifiers appear in). */
function received(shares: bigint, t: number): ModelNote {
    return {
        commitment: hex(),
        nullifier: hex(),
        shares,
        status: NoteStatus.ACTIVE,
        createdAt: t,
        originatedHere: false,
    };
}

/** A change note our own spend produced. */
function change(shares: bigint, t: number): ModelNote {
    return { ...received(shares, t), createdAt: t };
}

function facts(notes: readonly ModelNote[]): YieldDepositFact[] {
    return notes.flatMap((n) => (n.fact ? [n.fact] : []));
}

function noEvents(): YieldEarnedEvents {
    return { deposits: [], spends: [], ragequits: [] };
}

function compute(
    vault: Vault,
    notes: readonly ModelNote[],
    now: number,
    overrides: Partial<ComputeYieldEarnedArgs> = {},
): YieldEarned {
    return computeYieldEarned({
        share: SHARE,
        shareDecimals: SHARE_DECIMALS,
        notes,
        depositFacts: facts(notes),
        rateSeries: series(vault, Math.floor((now - T0) / HOUR)),
        events: noEvents(),
        exchangeRateNow: rateAt(vault, now),
        now,
        ...overrides,
    });
}

function ok(result: YieldEarned): Extract<YieldEarned, { status: "ok" }> {
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    return result;
}

function abs(x: bigint): bigint {
    return x < 0n ? -x : x;
}

const VAULTS: Vault[] = [
    { r0: 1_000_038n, slopePerHour: 3n, feeBps: 0n },
    { r0: 1_020_000n, slopePerHour: 7n, feeBps: 100n },
    { r0: 1_000_000n, slopePerHour: 1n, feeBps: 2000n },
];

describe("computeYieldEarned: two deposits equal one deposit of their sum at the same instant", () => {
    const CASES: { v1: bigint; v2: bigint }[] = [
        { v1: 50n * UNIT, v2: 25n * UNIT }, // whole shares: exact division everywhere
        { v1: 49_747_910_585_665_987_693n, v2: 12_345_678_901_234_567_890n }, // mainnet-shaped values
    ];
    for (const vault of VAULTS) {
        for (const { v1, v2 } of CASES) {
            it(`agree within one unit of underlying (fee ${vault.feeBps} bps, ${v1}+${v2})`, () => {
                const tDeposit = T0 + 5 * HOUR;
                const now = T0 + 200 * HOUR;
                const two = ok(
                    compute(
                        vault,
                        [deposit(vault, v1, tDeposit), deposit(vault, v2, tDeposit)],
                        now,
                    ),
                );
                const one = ok(compute(vault, [deposit(vault, v1 + v2, tDeposit)], now));
                expect(two.heldShares).toBe(one.heldShares);
                expect(two.heldUnderlyingNow).toBe(one.heldUnderlyingNow);
                // Two router calls each round their underlying up once AND each pay the
                // zap's supply buffer, so splitting a deposit genuinely costs the user a
                // little more: one rounding unit plus one extra buffer. That is a property
                // of the producer, not slack in the assertion — the bound was 1 while the
                // fixture omitted the buffer, which is how the omission stayed hidden.
                const SPLIT_COST = 1n + ZAP_SUPPLY_ROUNDING_BUFFER;
                expect(abs(two.valueIn - one.valueIn)).toBeLessThanOrEqual(SPLIT_COST);
                expect(abs(two.earnedTotal - one.earnedTotal)).toBeLessThanOrEqual(SPLIT_COST);
                expect(two.flows).toHaveLength(2);
                expect(two.flows.every((f) => f.basisSource === "deposit-facts")).toBe(true);
            });
        }
    }
});

describe("computeYieldEarned: a partial spend with change leaves earnedTotal unchanged at that instant", () => {
    const CASES: { v: bigint; x: bigint }[] = [
        { v: 100n * UNIT, x: 40n * UNIT },
        { v: 49_747_910_585_665_987_693n, x: 30_000_000_000_000_000_001n },
    ];
    for (const vault of VAULTS.slice(0, 2)) {
        for (const { v, x } of CASES) {
            it(`hold vs spend ${x} of ${v} at an observation tick (fee ${vault.feeBps} bps)`, () => {
                const tDeposit = T0 + 2 * HOUR;
                const tSpend = T0 + 50 * HOUR; // on the grid: floor and ceil rate coincide
                const dep = deposit(vault, v, tDeposit);
                const heldOnly = ok(compute(vault, [dep], tSpend));

                const changeNote = change(v - x, tSpend);
                const spendTx = hex() as Hash;
                const events: YieldEarnedEvents = {
                    deposits: [],
                    spends: [
                        {
                            txHash: spendTx,
                            at: tSpend,
                            nullifierHashes: [dep.nullifier],
                            outputCommitments: [changeNote.commitment, hex()],
                            withdrawnShares: 0n,
                        },
                    ],
                    ragequits: [],
                };
                const spent = ok(
                    compute(vault, [{ ...dep, status: NoteStatus.SPENT }, changeNote], tSpend, {
                        events,
                    }),
                );
                expect(spent.heldShares).toBe(v - x);
                expect(abs(spent.earnedTotal - heldOnly.earnedTotal)).toBeLessThanOrEqual(1n);
                expect(spent.valueIn).toBe(heldOnly.valueIn);
                const sent = spent.flows.filter((f) => f.kind === "sent");
                expect(sent).toHaveLength(1);
                expect(sent[0]!.shares).toBe(x);
                expect(sent[0]!.txHash).toBe(spendTx);
                // The change note is internal: no flow of its own.
                expect(spent.flows.map((f) => f.kind).sort()).toEqual(["deposit", "sent"]);
                expect(spent.earnedRealized + spent.earnedUnrealized).toBe(spent.earnedTotal);
            });
        }
    }
});

describe("computeYieldEarned: sender-realised plus recipient-since-receipt equals the vault's growth", () => {
    const CASES: { v: bigint; x: bigint; dHours: number; xHours: number; nHours: number }[] = [
        { v: 100n * UNIT, x: 60n * UNIT, dHours: 1, xHours: 30, nHours: 120 },
        {
            v: 77_777_777_777_777_777_777n,
            x: 1_234_567_890_123_456_789n,
            dHours: 3,
            xHours: 71,
            nHours: 500,
        },
    ];
    for (const vault of VAULTS.slice(0, 2)) {
        for (const c of CASES) {
            it(`conserve yield across a transfer of ${c.x} (fee ${vault.feeBps} bps)`, () => {
                const tDeposit = T0 + c.dHours * HOUR;
                const tTransfer = T0 + c.xHours * HOUR;
                const now = T0 + c.nHours * HOUR;
                const dep = deposit(vault, c.v, tDeposit);
                const senderChange = change(c.v - c.x, tTransfer);
                const recipientNote = received(c.x, tTransfer);
                const spend = {
                    txHash: hex() as Hash,
                    at: tTransfer,
                    nullifierHashes: [dep.nullifier],
                    outputCommitments: [senderChange.commitment, recipientNote.commitment],
                    withdrawnShares: 0n,
                };
                const events: YieldEarnedEvents = { deposits: [], spends: [spend], ragequits: [] };

                const sender = ok(
                    compute(vault, [{ ...dep, status: NoteStatus.SPENT }, senderChange], now, {
                        events,
                    }),
                );
                // The recipient's wallet holds none of the sender's nullifiers, so the same spend is
                // somebody else's transact to it.
                const recipient = ok(
                    compute(vault, [recipientNote], now, { events, depositFacts: [] }),
                );

                const growth = (c.v * (rateAt(vault, now) - rateAt(vault, tDeposit))) / UNIT;
                // Basis of the vetting fee shares is not the user's principal, so the vault's growth
                // is measured on the note's shares against the fact basis.
                const factBasis =
                    (dep.fact!.grossUnderlying * dep.fact!.noteShares) /
                    dep.fact!.totalSharesMinted;
                const expected = (c.v * rateAt(vault, now)) / UNIT - factBasis;
                expect(growth >= 0n).toBe(true);
                const total = sender.earnedTotal + recipient.earnedTotal;
                // Three rounded figures meet here (sender out, recipient in, two held legs).
                expect(abs(total - expected)).toBeLessThanOrEqual(4n);
                expect(total).toBeLessThanOrEqual(expected);
                expect(
                    total + sender.maxUnderstatement + recipient.maxUnderstatement,
                ).toBeGreaterThanOrEqual(expected);
                expect(recipient.flows[0]!.kind).toBe("received");
                expect(recipient.flows[0]!.basisSource).toBe("rate-series");
            });
        }
    }
});

describe("computeYieldEarned: never overstates and the bound covers the truth", () => {
    // Off-grid times: every rate-priced flow is bracketed by two observations.
    const SCENARIOS = [
        {
            vault: VAULTS[0]!,
            recvShares: 10n * UNIT,
            recvAt: T0 + 10 * HOUR + 1234,
            exitShares: 3n * UNIT,
            exitAt: T0 + 40 * HOUR + 59,
            now: T0 + 90 * HOUR + 7,
        },
        {
            vault: VAULTS[1]!,
            recvShares: 987_654_321_987_654_321n,
            recvAt: T0 + 61 * HOUR + 3599,
            exitShares: 100_000_000_000_000_000n,
            exitAt: T0 + 70 * HOUR + 1800,
            now: T0 + 71 * HOUR + 1,
        },
    ];
    for (const s of SCENARIOS) {
        it(`bound the understatement of a received-then-partly-sent position (slope ${s.vault.slopePerHour})`, () => {
            const recv = received(s.recvShares, s.recvAt);
            const remainder = change(s.recvShares - s.exitShares, s.exitAt);
            const events: YieldEarnedEvents = {
                deposits: [],
                spends: [
                    // The spend that delivered the received note (not ours).
                    {
                        txHash: hex() as Hash,
                        at: s.recvAt,
                        nullifierHashes: [hex()],
                        outputCommitments: [recv.commitment],
                        withdrawnShares: 0n,
                    },
                    // Our partial withdrawal of it.
                    {
                        txHash: hex() as Hash,
                        at: s.exitAt,
                        nullifierHashes: [recv.nullifier],
                        outputCommitments: [remainder.commitment],
                        withdrawnShares: s.exitShares,
                    },
                ],
                ragequits: [],
            };
            const result = ok(
                compute(s.vault, [{ ...recv, status: NoteStatus.SPENT }, remainder], s.now, {
                    events,
                    depositFacts: [],
                }),
            );
            const rNow = rateAt(s.vault, s.now);
            const truth =
                (s.exitShares * rateAt(s.vault, s.exitAt)) / UNIT +
                ((s.recvShares - s.exitShares) * rNow) / UNIT -
                (s.recvShares * rateAt(s.vault, s.recvAt)) / UNIT;
            expect(result.earnedTotal).toBeLessThanOrEqual(truth);
            expect(result.earnedTotal + result.maxUnderstatement).toBeGreaterThanOrEqual(truth);
            expect(result.flows.map((f) => f.kind)).toEqual(["received", "withdrawn"]);
            expect(result.flows.every((f) => f.basisSource === "rate-series")).toBe(true);
            expect(result.asOf.exchangeRateNow).toBe(rNow);
        });
    }
});

describe("computeYieldEarned: a note dated before the first observation clamps and reports the bound", () => {
    const CASES = [
        { vault: VAULTS[0]!, shares: 50n * UNIT, minutesBefore: 26 },
        { vault: VAULTS[2]!, shares: 3_333_333_333_333_333_333n, minutesBefore: 12 * 60 + 24 },
    ];
    for (const c of CASES) {
        it(`clamp a received note ${c.minutesBefore} min pre-series onto the first snapshot`, () => {
            const seriesStart = T0 + 24 * HOUR;
            const recvAt = seriesStart - c.minutesBefore * 60;
            const now = seriesStart + 100 * HOUR;
            const recv = received(c.shares, recvAt);
            const events: YieldEarnedEvents = {
                deposits: [],
                spends: [
                    {
                        txHash: null,
                        at: recvAt,
                        nullifierHashes: [hex()],
                        outputCommitments: [recv.commitment],
                        withdrawnShares: null,
                    },
                ],
                ragequits: [],
            };
            const rateSeries = series(c.vault, 100, { from: seriesStart });
            const result = ok(
                compute(c.vault, [recv], now, {
                    events,
                    depositFacts: [],
                    rateSeries,
                    exchangeRateNow: rateAt(c.vault, now),
                }),
            );
            const first = rateSeries.observations[0]!.exchangeRate;
            expect(result.flows[0]!.basisSource).toBe("rate-series-clamped");
            // Basis at the first snapshot (the high end of the pre-series bracket).
            expect(result.valueIn).toBe(ceilDiv(c.shares * first, UNIT));
            // The bound is at least the bracket width [inception, first] on these shares.
            expect(result.maxUnderstatement).toBeGreaterThanOrEqual(
                (c.shares * (first - INCEPTION)) / UNIT,
            );
            const truth =
                (c.shares * rateAt(c.vault, now)) / UNIT -
                (c.shares * rateAt(c.vault, recvAt)) / UNIT;
            expect(result.earnedTotal).toBeLessThanOrEqual(truth);
            expect(result.earnedTotal + result.maxUnderstatement).toBeGreaterThanOrEqual(truth);
        });
    }
});

describe("computeYieldEarned: exits", () => {
    const vault = VAULTS[0]!;

    it("split a spend into withdrawn and sent legs when withdrawnValue is known, value the total the same", () => {
        const dep = deposit(vault, 100n * UNIT, T0 + HOUR);
        const tSpend = T0 + 10 * HOUR;
        const spend = {
            txHash: hex() as Hash,
            at: tSpend,
            nullifierHashes: [dep.nullifier],
            outputCommitments: [hex(), hex()],
            withdrawnShares: 70n * UNIT,
        };
        const events: YieldEarnedEvents = { deposits: [], spends: [spend], ragequits: [] };
        const known = ok(
            compute(vault, [{ ...dep, status: NoteStatus.SPENT }], tSpend, { events }),
        );
        const legs = known.flows.filter((f) => f.kind !== "deposit");
        expect(legs.map((f) => [f.kind, f.shares])).toEqual([
            ["withdrawn", 70n * UNIT],
            ["sent", 30n * UNIT],
        ]);

        const unknown = ok(
            compute(vault, [{ ...dep, status: NoteStatus.SPENT }], tSpend, {
                events: { ...events, spends: [{ ...spend, withdrawnShares: null }] },
            }),
        );
        expect(unknown.flows.filter((f) => f.kind === "spent")).toHaveLength(1);
        expect(unknown.valueOut).toBe(known.valueOut);
        expect(unknown.earnedTotal).toBe(known.earnedTotal);
        expect(known.heldShares).toBe(0n);
        expect(known.earnedUnrealized).toBe(0n);
        expect(known.earnedRealized).toBe(known.earnedTotal);
    });

    it("value a ragequit at the rate when it happened and treat the note as gone whatever its local status", () => {
        const dep = deposit(vault, 10n * UNIT, T0 + HOUR);
        const tExit = T0 + 20 * HOUR;
        const events: YieldEarnedEvents = {
            deposits: [],
            spends: [],
            ragequits: [{ txHash: hex() as Hash, at: tExit, commitment: dep.commitment }],
        };
        const now = T0 + 30 * HOUR;
        for (const status of [NoteStatus.EXITED, NoteStatus.EXIT_PENDING, NoteStatus.ACTIVE]) {
            const result = ok(compute(vault, [{ ...dep, status }], now, { events }));
            expect(result.heldShares).toBe(0n);
            expect(result.flows.map((f) => f.kind)).toEqual(["deposit", "ragequit"]);
            expect(result.valueOut).toBe((10n * UNIT * rateAt(vault, tExit)) / UNIT);
        }
    });

    it("treat a spend whose nullifiers name a note the local store still calls ACTIVE as spent", () => {
        const dep = deposit(vault, 10n * UNIT, T0 + HOUR);
        const tSpend = T0 + 5 * HOUR;
        const events: YieldEarnedEvents = {
            deposits: [],
            spends: [
                {
                    txHash: null,
                    at: tSpend,
                    nullifierHashes: [dep.nullifier],
                    outputCommitments: [hex()],
                    withdrawnShares: 10n * UNIT,
                },
            ],
            ragequits: [],
        };
        const result = ok(compute(vault, [dep], T0 + 6 * HOUR, { events }));
        expect(result.heldShares).toBe(0n);
        expect(result.flows.map((f) => f.kind)).toEqual(["deposit", "withdrawn"]);
    });

    it("match commitments and nullifiers whatever their hex spelling", () => {
        const dep = deposit(vault, 10n * UNIT, T0 + HOUR);
        const shortNullifier = `0x${BigInt(dep.nullifier).toString(16)}` as Hex;
        const upperCommitment = dep.fact!.outputCommitment.toUpperCase().replace("0X", "0x") as Hex;
        const result = ok(
            compute(vault, [{ ...dep, status: NoteStatus.SPENT }], T0 + 6 * HOUR, {
                depositFacts: [
                    {
                        ...dep.fact!,
                        outputCommitment: upperCommitment,
                        asset: SHARE.toUpperCase().replace("0X", "0x") as Address,
                    },
                ],
                events: {
                    deposits: [],
                    spends: [
                        {
                            txHash: null,
                            at: T0 + 5 * HOUR,
                            nullifierHashes: [shortNullifier],
                            outputCommitments: [],
                            withdrawnShares: null,
                        },
                    ],
                    ragequits: [],
                },
            }),
        );
        expect(result.flows.map((f) => f.kind)).toEqual(["deposit", "spent"]);
    });
});

describe("computeYieldEarned: fails closed", () => {
    const vault = VAULTS[0]!;
    const now = T0 + 10 * HOUR;

    function expectUnavailable(result: YieldEarned, reason: string): void {
        expect(result.status).toBe("unavailable");
        if (result.status !== "unavailable") throw new Error("unreachable");
        expect(result.reason).toBe(reason);
        // Never a number: the unavailable shape carries no figure at all.
        expect(Object.keys(result).sort()).toEqual(
            result.detail === undefined ? ["reason", "status"] : ["detail", "reason", "status"],
        );
        expect(JSON.stringify(result)).not.toMatch(/0x[0-9a-f]{64}/);
    }

    it("return no-rate-series when the rate feed answered 404 or came back empty", () => {
        const dep = deposit(vault, UNIT, T0 + HOUR);
        expectUnavailable(compute(vault, [dep], now, { rateSeries: null }), "no-rate-series");
        expectUnavailable(
            compute(vault, [dep], now, { rateSeries: { ...series(vault, 1), observations: [] } }),
            "no-rate-series",
        );
    });

    it("return no-deposit-facts when the facts feed answered 404, even for a received-only wallet", () => {
        const recv = received(UNIT, T0 + HOUR);
        const events: YieldEarnedEvents = {
            deposits: [],
            spends: [
                {
                    txHash: null,
                    at: T0 + HOUR,
                    nullifierHashes: [hex()],
                    outputCommitments: [recv.commitment],
                    withdrawnShares: 0n,
                },
            ],
            ragequits: [],
        };
        expectUnavailable(
            compute(vault, [recv], now, { events, depositFacts: null }),
            "no-deposit-facts",
        );
    });

    it("return deposit-fact-missing for an own deposit the facts feed has not indexed, never pricing it off the rate series", () => {
        const dep = deposit(vault, UNIT, T0 + HOUR);
        // Own by depositSecret.
        expectUnavailable(compute(vault, [dep], now, { depositFacts: [] }), "deposit-fact-missing");
        // Own by the Deposited event, without a depositSecret (imported account).
        expectUnavailable(
            compute(vault, [{ ...dep, originatedHere: false }], now, {
                depositFacts: [],
                events: { deposits: [{ commitment: dep.commitment }], spends: [], ragequits: [] },
            }),
            "deposit-fact-missing",
        );
        // A fact for another share does not count.
        expectUnavailable(
            compute(vault, [dep], now, {
                depositFacts: [
                    {
                        ...dep.fact!,
                        asset: "0xa4cf419558ef36cc6ffb666195684dc963910426" as Address,
                    },
                ],
            }),
            "deposit-fact-missing",
        );
    });

    it("return unresolved-origin for a note no deposit and no transact explains", () => {
        const stray = received(UNIT, T0 + HOUR);
        expectUnavailable(compute(vault, [stray], now, { depositFacts: [] }), "unresolved-origin");
    });

    it("return note-timestamp-missing for a received note whose createdAt is not a timestamp", () => {
        const recv = { ...received(UNIT, T0 + HOUR), createdAt: null };
        const events: YieldEarnedEvents = {
            deposits: [],
            spends: [
                {
                    txHash: null,
                    at: T0 + HOUR,
                    nullifierHashes: [hex()],
                    outputCommitments: [recv.commitment],
                    withdrawnShares: 0n,
                },
            ],
            ragequits: [],
        };
        expectUnavailable(
            compute(vault, [recv], now, { events, depositFacts: [] }),
            "note-timestamp-missing",
        );
    });

    it("return exit-timestamp-missing for a spent or exited note with no dated event", () => {
        const dep = deposit(vault, UNIT, T0 + HOUR);
        for (const status of [NoteStatus.SPENT, NoteStatus.EXITED, NoteStatus.EXIT_PENDING]) {
            expectUnavailable(compute(vault, [{ ...dep, status }], now), "exit-timestamp-missing");
        }
        // The event exists but carries no timestamp: recognised as a spend, still not accountable.
        expectUnavailable(
            compute(vault, [{ ...dep, status: NoteStatus.SPENT }], now, {
                events: {
                    deposits: [],
                    spends: [
                        {
                            txHash: null,
                            at: null,
                            nullifierHashes: [dep.nullifier],
                            outputCommitments: [],
                            withdrawnShares: null,
                        },
                    ],
                    ragequits: [],
                },
            }),
            "exit-timestamp-missing",
        );
        expectUnavailable(
            compute(vault, [{ ...dep, status: NoteStatus.EXITED }], now, {
                events: {
                    deposits: [],
                    spends: [],
                    ragequits: [{ txHash: null, at: null, commitment: dep.commitment }],
                },
            }),
            "exit-timestamp-missing",
        );
    });

    it("return rate-coverage-gap for a flow dated after now", () => {
        const recv = received(UNIT, now + 1);
        const events: YieldEarnedEvents = {
            deposits: [],
            spends: [
                {
                    txHash: null,
                    at: now + 1,
                    nullifierHashes: [hex()],
                    outputCommitments: [recv.commitment],
                    withdrawnShares: 0n,
                },
            ],
            ragequits: [],
        };
        expectUnavailable(
            compute(vault, [recv], now, { events, depositFacts: [] }),
            "rate-coverage-gap",
        );
    });

    it("return inconsistent when the series is not monotone or the live rate fell below it", () => {
        const dep = deposit(vault, UNIT, T0 + HOUR);
        const good = series(vault, 10);
        const dip = {
            ...good,
            observations: good.observations.map((o, i) =>
                i === 5 ? { ...o, exchangeRate: o.exchangeRate - 10n } : o,
            ),
        };
        expectUnavailable(compute(vault, [dep], now, { rateSeries: dip }), "inconsistent");
        expectUnavailable(
            compute(vault, [dep], now, {
                exchangeRateNow: good.observations[0]!.exchangeRate - 1n,
            }),
            "inconsistent",
        );
        expectUnavailable(compute(vault, [dep], now, { exchangeRateNow: 0n }), "inconsistent");
    });

    it("return inconsistent when a deposit fact disagrees with the note or shares do not conserve", () => {
        const dep = deposit(vault, UNIT, T0 + HOUR);
        expectUnavailable(
            compute(vault, [dep], now, { depositFacts: [{ ...dep.fact!, noteShares: UNIT + 1n }] }),
            "inconsistent",
        );
        // A spend that produces more owned shares than it consumed cannot be right.
        const bigChange = change(2n * UNIT, T0 + 5 * HOUR);
        expectUnavailable(
            compute(vault, [{ ...dep, status: NoteStatus.SPENT }, bigChange], now, {
                events: {
                    deposits: [],
                    spends: [
                        {
                            txHash: null,
                            at: T0 + 5 * HOUR,
                            nullifierHashes: [dep.nullifier],
                            outputCommitments: [bigChange.commitment],
                            withdrawnShares: 0n,
                        },
                    ],
                    ragequits: [],
                },
            }),
            "inconsistent",
        );
        // Two notes with one commitment.
        expectUnavailable(compute(vault, [dep, { ...dep, nullifier: hex() }], now), "inconsistent");
    });

    it("return ok with zeros for a wallet with no notes of the share, never unavailable", () => {
        const result = ok(compute(vault, [], now, { depositFacts: [] }));
        expect(result.earnedTotal).toBe(0n);
        expect(result.heldShares).toBe(0n);
        expect(result.maxUnderstatement).toBe(0n);
        expect(result.flows).toEqual([]);
    });
});

describe("yieldEarnedEventsFromSnapshot", () => {
    it("reduce snapshot rows to seconds, bigints and commitments, keeping undated rows with at: null", () => {
        const snapshot: Pick<EventSnapshot, "deposits" | "transacts" | "ragequits"> = {
            deposits: [
                {
                    txHash: null,
                    logIndex: null,
                    depositAddress: null,
                    outputCommitment: "0x01",
                    depositedValue: null,
                    fee: null,
                    blockNumber: null,
                    blockTimestamp: null,
                    asset: null,
                },
            ],
            transacts: [
                {
                    txHash: `0x${"ab".repeat(32)}` as Hash,
                    logIndex: 1,
                    outputCommitments: ["0x02", "0x03"],
                    nullifierHashes: ["0x04"],
                    caller: null,
                    withdrawnValue: "0x0a",
                    encryptedPayload: null,
                    blockNumber: "0x10",
                    blockTimestamp: "2026-09-04T20:44:59.000Z",
                    asset: null,
                },
                {
                    txHash: null,
                    logIndex: null,
                    outputCommitments: [],
                    nullifierHashes: ["0x05"],
                    caller: null,
                    withdrawnValue: null,
                    encryptedPayload: null,
                    blockNumber: null,
                    blockTimestamp: "not a date",
                    asset: null,
                },
            ],
            ragequits: [
                {
                    txHash: null,
                    logIndex: null,
                    ragequitter: null,
                    withdrawnValue: null,
                    commitment: "0x06",
                    nullifierHash: null,
                    label: null,
                    blockNumber: "0x11",
                    blockTimestamp: null,
                    asset: null,
                },
            ],
        };
        expect(yieldEarnedEventsFromSnapshot(snapshot)).toEqual({
            deposits: [{ commitment: "0x01" }],
            spends: [
                {
                    txHash: `0x${"ab".repeat(32)}`,
                    at: 1_788_554_699,
                    nullifierHashes: ["0x04"],
                    outputCommitments: ["0x02", "0x03"],
                    withdrawnShares: 10n,
                },
                {
                    txHash: null,
                    at: null,
                    nullifierHashes: ["0x05"],
                    outputCommitments: [],
                    withdrawnShares: null,
                },
            ],
            ragequits: [{ txHash: null, at: null, commitment: "0x06" }],
        });
    });
});

describe("computeYieldEarned: inputs that must never produce a number", () => {
    const vault = VAULTS[0]!;
    const OTHER_SHARE = "0xa4cf419558ef36cc6ffb666195684dc963910426" as Address;

    function unavailableFor(result: YieldEarned): string {
        expect(result.status).toBe("unavailable");
        if (result.status !== "unavailable") throw new Error("unreachable");
        // Whatever the reason, no figure may ride along.
        expect(JSON.stringify(result)).not.toMatch(/earnedTotal/);
        return result.reason;
    }

    // The one that produced a wrong number rather than refusing: an account holding
    // ppUSDC and ppUSDT, looped over with one feed bundle, priced ppUSDC's notes with
    // ppUSDT's history. Measured at 41x the truth, status ok, no bound.
    it("refuses a rate series belonging to a different share", () => {
        const notes = [deposit(vault, 1000n * UNIT, T0 + HOUR)];
        const now = T0 + 100 * HOUR;
        const wrongSeries = { ...series(vault, 100), share: OTHER_SHARE };
        expect(unavailableFor(compute(vault, notes, now, { rateSeries: wrongSeries }))).toBe(
            "inconsistent",
        );
        // Spelling must not matter: the same share in another case is the same share.
        const sameShareUpper = {
            ...series(vault, 100),
            share: SHARE.toUpperCase() as Address,
        };
        expect(compute(vault, notes, now, { rateSeries: sameShareUpper }).status).toBe("ok");
    });

    it("refuses a series whose share decimals disagree with the deployment", () => {
        const notes = [deposit(vault, 1000n * UNIT, T0 + HOUR)];
        const now = T0 + 100 * HOUR;
        const wrongDecimals = { ...series(vault, 100), shareDecimals: 6 };
        expect(unavailableFor(compute(vault, notes, now, { rateSeries: wrongDecimals }))).toBe(
            "inconsistent",
        );
    });

    // A dropped transact row is missing state, not absent state: without this the note
    // reads as never spent and its shares get valued at the live rate.
    it("refuses when the snapshot dropped spend rows", () => {
        const notes = [deposit(vault, 1000n * UNIT, T0 + HOUR)];
        const now = T0 + 100 * HOUR;
        const events = { ...noEvents(), incomplete: true };
        expect(unavailableFor(compute(vault, notes, now, { events }))).toBe("inconsistent");
    });

    // Conservation break the transact circuit forbids. Clamping it answered with a number
    // drawn from data that cannot be right.
    it("refuses a spend that withdrew more shares than it consumed", () => {
        const note = deposit(vault, 100n * UNIT, T0 + HOUR);
        const now = T0 + 100 * HOUR;
        const events: YieldEarnedEvents = {
            deposits: [],
            ragequits: [],
            spends: [
                {
                    txHash: hex() as Hash,
                    at: T0 + 50 * HOUR,
                    nullifierHashes: [note.nullifier],
                    outputCommitments: [],
                    withdrawnShares: 200n * UNIT,
                },
            ],
        };
        expect(unavailableFor(compute(vault, [note], now, { events }))).toBe("inconsistent");
    });
});

describe("yieldEarnedEventsFromSnapshot: coverage loss travels with the events", () => {
    const base = {
        deposits: [],
        transacts: [],
        ragequits: [],
    } as unknown as Pick<EventSnapshot, "deposits" | "transacts" | "ragequits">;

    it("a clean snapshot is not marked incomplete", () => {
        expect(yieldEarnedEventsFromSnapshot(base).incomplete).toBeUndefined();
        expect(
            yieldEarnedEventsFromSnapshot({ ...base, drops: {} } as never).incomplete,
        ).toBeUndefined();
    });

    it("dropped transact or ragequit rows mark it incomplete", () => {
        for (const array of ["transacts", "ragequits"] as const) {
            const snapshot = {
                ...base,
                drops: { [array]: { dropped: 1, earliestDroppedBlock: null } },
            } as never;
            expect(yieldEarnedEventsFromSnapshot(snapshot).incomplete).toBe(true);
        }
    });

    // A missing deposit fact is caught per note as `deposit-fact-missing`, so losing
    // deposit rows must not blank the whole position.
    it("dropped DEPOSIT rows alone do not mark it incomplete", () => {
        const snapshot = {
            ...base,
            drops: { deposits: { dropped: 3, earliestDroppedBlock: null } },
        } as never;
        expect(yieldEarnedEventsFromSnapshot(snapshot).incomplete).toBeUndefined();
    });
});
