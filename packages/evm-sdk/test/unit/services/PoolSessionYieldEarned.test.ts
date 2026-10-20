import { describe, expect, it, vi } from "vitest";

import type {
    Address,
    Hex,
    IKeystoreManager,
    INoteComputationService,
    INoteManager,
    IPPYieldTokenInteractor,
    Note,
    YieldEarnedEvents,
    YieldRateSeries,
} from "../../../src/internal.js";
import {
    bigintToHex,
    LOCAL_FORK_YIELD_DEPLOYMENT,
    MIN_PLAUSIBLE_NOTE_TIMESTAMP,
    NoteStatus,
    noteTimestamp,
    EvmPoolSessionYieldEarned,
} from "../../../src/internal.js";

const DEP = LOCAL_FORK_YIELD_DEPLOYMENT;
const UNIT = 10n ** 18n;
const T0 = 1_757_000_000;
const RATE = 1_000_038n;
const NULLIFYING_KEY = `0x${"77".repeat(32)}` as Hex;

/** The test's nullifier derivation: deterministic and distinct per commitment. */
function nullifierOf(commitment: Hex): Hex {
    return bigintToHex(BigInt(commitment) + 1_000_000n);
}

function note(overrides: Partial<Note> & { commitment: Hex }): Note {
    return {
        noteAddressHash: "0x01",
        value: bigintToHex(UNIT),
        tokenId: DEP.ppUSDC,
        label: "0x02",
        status: NoteStatus.ACTIVE,
        ownerAddress: "0x742d35cc6634c0532925a3b844bc9e7fe0c0f392",
        noteSecret: "0x03",
        isOwned: true,
        createdAtBlock: bigintToHex(BigInt(T0 + 3600)),
        spentAtBlock: null,
        txHash: "0x04",
        ...overrides,
    };
}

function series(): YieldRateSeries {
    return {
        share: DEP.ppUSDC.toLowerCase() as Address,
        shareDecimals: 18,
        assetDecimals: 6,
        observations: [0, 1, 2, 3].map((i) => ({
            timestamp: T0 + i * 3600,
            exchangeRate: RATE + BigInt(i),
            block: BigInt(100 + i),
        })),
    };
}

function harness(notes: Note[]): {
    session: EvmPoolSessionYieldEarned;
    exchangeRate: ReturnType<typeof vi.fn<[], Promise<bigint>>>;
} {
    const noteManager = { getNotes: vi.fn(() => notes) } as unknown as INoteManager;
    const keystoreManager = {
        getPrivateNullifyingKey: vi.fn(() => NULLIFYING_KEY),
    } as unknown as IKeystoreManager;
    const noteComputationService = {
        computeNullifier: vi.fn((key: Hex, commitment: Hex) => {
            expect(key).toBe(NULLIFYING_KEY);
            return nullifierOf(commitment);
        }),
    } as unknown as INoteComputationService;
    const exchangeRate = vi.fn(async () => RATE + 3n);
    const yieldToken = { exchangeRate } as unknown as IPPYieldTokenInteractor;
    const session = new EvmPoolSessionYieldEarned({
        deployment: DEP,
        noteManager,
        keystoreManager,
        noteComputationService,
        yieldToken,
    });
    return { session, exchangeRate };
}

describe("PoolSessionYieldEarned", () => {
    it("value only the wallet's own notes of this share, matching the token case-insensitively", async () => {
        const mine = note({ commitment: "0x10", depositSecret: "0x05" });
        const upperCased = note({
            commitment: "0x11",
            depositSecret: "0x05",
            tokenId: DEP.ppUSDC.toUpperCase().replace("0X", "0x") as Address,
        });
        const otherToken = note({ commitment: "0x12", tokenId: DEP.underlying });
        const notOwned = note({ commitment: "0x13", isOwned: false });
        const { session, exchangeRate } = harness([mine, upperCased, otherToken, notOwned]);

        const result = await session.compute({
            depositFacts: [mine, upperCased].map((n) => ({
                outputCommitment: n.commitment,
                asset: DEP.ppUSDC,
                txHash: "0x99" as Hex,
                grossUnderlying: 1_000_038n,
                noteShares: UNIT,
                totalSharesMinted: UNIT,
                vettingFeeShares: 0n,
                blockTimestamp: T0 + 3600,
            })),
            rateSeries: series(),
            events: { deposits: [], spends: [], ragequits: [] },
            now: T0 + 3 * 3600,
        });

        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error("unreachable");
        expect(result.heldShares).toBe(2n * UNIT);
        expect(result.flows).toHaveLength(2);
        expect(result.asOf.exchangeRateNow).toBe(RATE + 3n);
        expect(exchangeRate).toHaveBeenCalledTimes(1);
        expect(exchangeRate).toHaveBeenCalledWith();
    });

    it("report note-timestamp-missing, never a number, for a received note whose createdAtBlock holds a block number", async () => {
        const legacy = note({ commitment: "0x20", createdAtBlock: "0x18b3a2c" }); // 25 906 428: a block, not a time
        const events: YieldEarnedEvents = {
            deposits: [],
            spends: [
                {
                    txHash: null,
                    at: T0 + 3600,
                    nullifierHashes: ["0xdead"],
                    outputCommitments: [legacy.commitment],
                    withdrawnShares: 0n,
                },
            ],
            ragequits: [],
        };
        const { session } = harness([legacy]);
        const result = await session.compute({
            depositFacts: [],
            rateSeries: series(),
            events,
            now: T0 + 3 * 3600,
        });
        expect(result).toEqual({ status: "unavailable", reason: "note-timestamp-missing" });
    });

    it("read exchangeRate() exactly once per call, with no argument, whatever the feeds hold", async () => {
        const { session, exchangeRate } = harness([
            note({ commitment: "0x30", depositSecret: "0x05" }),
        ]);
        const events: YieldEarnedEvents = { deposits: [], spends: [], ragequits: [] };
        await session.compute({ depositFacts: null, rateSeries: null, events });
        await session.compute({ depositFacts: [], rateSeries: series(), events });
        expect(exchangeRate).toHaveBeenCalledTimes(2);
        for (const call of exchangeRate.mock.calls) expect(call).toEqual([]);
    });

    it("find the wallet's spends through nullifiers derived with its own nullifying key", async () => {
        const dep = note({ commitment: "0x40", depositSecret: "0x05", status: NoteStatus.SPENT });
        const { session } = harness([dep]);
        const result = await session.compute({
            depositFacts: [
                {
                    outputCommitment: dep.commitment,
                    asset: DEP.ppUSDC,
                    txHash: "0x99" as Hex,
                    grossUnderlying: 1_000_038n,
                    noteShares: UNIT,
                    totalSharesMinted: UNIT,
                    vettingFeeShares: 0n,
                    blockTimestamp: T0 + 3600,
                },
            ],
            rateSeries: series(),
            events: {
                deposits: [],
                spends: [
                    {
                        txHash: "0x77" as Hex,
                        at: T0 + 2 * 3600,
                        nullifierHashes: [nullifierOf(dep.commitment)],
                        outputCommitments: [],
                        withdrawnShares: UNIT,
                    },
                ],
                ragequits: [],
            },
            now: T0 + 3 * 3600,
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error("unreachable");
        expect(result.flows.map((f) => f.kind)).toEqual(["deposit", "withdrawn"]);
        expect(result.heldShares).toBe(0n);
    });
});

describe("noteTimestamp", () => {
    it("return the value as seconds when it can be a timestamp", () => {
        expect(noteTimestamp(bigintToHex(BigInt(T0)))).toBe(T0);
        expect(noteTimestamp(`0x${MIN_PLAUSIBLE_NOTE_TIMESTAMP.toString(16)}` as Hex)).toBe(
            MIN_PLAUSIBLE_NOTE_TIMESTAMP,
        );
    });

    it("return null for a block number, zero, garbage and anything beyond a safe integer", () => {
        expect(noteTimestamp("0x18b3a2c")).toBeNull();
        expect(noteTimestamp("0x0")).toBeNull();
        expect(noteTimestamp("0xzz" as Hex)).toBeNull();
        expect(noteTimestamp(bigintToHex(BigInt(Number.MAX_SAFE_INTEGER) + 1n))).toBeNull();
    });
});
