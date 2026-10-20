import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Hash,
    HttpASPDataProviderConfig,
    IHTTPClient,
    ILogger,
} from "../../../src/internal.js";
import {
    ASPUnavailable,
    bigintToHex,
    HttpASPDataProvider,
    InvalidASPClientConfig,
} from "../../../src/internal.js";

function createMockHttpClient(overrides?: Partial<IHTTPClient>): IHTTPClient {
    return {
        get: vi.fn(),
        post: vi.fn(),
        getBinary: vi.fn(),
        ...overrides,
    };
}

function createMockLogger(): ILogger {
    return {
        child: vi.fn(),
        level: "debug",
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
    };
}

const MOCK_ROOT = "0x0000000000000000000000000000000000000000000000000000000000abcdef" as Hash;

describe("HttpASPDataProvider", () => {
    let mockHttpClient: IHTTPClient;

    beforeEach(() => {
        vi.clearAllMocks();
        mockHttpClient = createMockHttpClient();
    });

    const validConfig = (): HttpASPDataProviderConfig => ({
        aspUrl: "https://asp.example.com",
        chainId: 1,
        entrypointAddress: "0xEB3e3961008952348445513e418ad6F43C23ca9a",
        httpClient: mockHttpClient,
    });

    describe("constructor", () => {
        it("create instance with valid config", () => {
            expect(() => new HttpASPDataProvider(validConfig())).not.toThrow();
        });

        it("throw InvalidASPClientConfig for invalid URL", () => {
            expect(
                () => new HttpASPDataProvider({ ...validConfig(), aspUrl: "not-a-url" }),
            ).toThrow(InvalidASPClientConfig);
        });

        it("throw InvalidASPClientConfig for invalid chainId", () => {
            expect(() => new HttpASPDataProvider({ ...validConfig(), chainId: -1 })).toThrow(
                InvalidASPClientConfig,
            );
        });

        it("accept a non-EVM entrypoint address, since it is an opaque per-chain scoping string", () => {
            expect(
                () =>
                    new HttpASPDataProvider({
                        ...validConfig(),
                        entrypointAddress:
                            "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUFNQRKQRV7GEDXKWNQEP",
                    }),
            ).not.toThrow();
        });

        it("throw InvalidASPClientConfig for an empty entrypoint address", () => {
            expect(
                () =>
                    new HttpASPDataProvider({
                        ...validConfig(),
                        entrypointAddress: "" as HttpASPDataProviderConfig["entrypointAddress"],
                    }),
            ).toThrow(InvalidASPClientConfig);
        });

        it("scope every chain-keyed endpoint to the configured entrypoint", async () => {
            // The ASP can serve several pools per chain; without the
            // entrypoint param it rejects ambiguous queries (HTTP 400) or, for
            // note-events, would merge streams across pools.
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                root: MOCK_ROOT,
                leaves: [],
                events: [],
                lastSyncedBlock: "0x1",
            });
            const provider = new HttpASPDataProvider(validConfig());
            await provider.getRoot();
            await provider.getLeaves();
            await provider.getNoteEvents();
            for (const [url] of vi.mocked(mockHttpClient.get).mock.calls) {
                expect(url).toContain("entrypoint=0xEB3e3961008952348445513e418ad6F43C23ca9a");
            }
        });
    });

    describe("getRoot", () => {
        it("return root from ASP API", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({ root: MOCK_ROOT });
            const provider = new HttpASPDataProvider(validConfig());
            const root = await provider.getRoot();
            expect(root).toBe(MOCK_ROOT);
            expect(mockHttpClient.get).toHaveBeenCalledWith(
                expect.stringContaining("/association-set/root?chainId=1"),
                expect.objectContaining({ cache: "no-store" }),
            );
        });

        it("throw ASPUnavailable on fetch error", async () => {
            vi.mocked(mockHttpClient.get).mockRejectedValue(new Error("Network error"));
            const provider = new HttpASPDataProvider(validConfig());
            await expect(provider.getRoot()).rejects.toThrow(ASPUnavailable);
        });
    });

    describe("getLeaves", () => {
        it("return leaves array from ASP API", async () => {
            const leaves = ["1" as Hash, "2" as Hash];
            const leavesResult = leaves.map((leaf) => bigintToHex(BigInt(leaf)));
            vi.mocked(mockHttpClient.get).mockResolvedValue({ leaves });
            const provider = new HttpASPDataProvider(validConfig());
            const result = await provider.getLeaves();
            expect(result).toEqual(leavesResult);
            expect(mockHttpClient.get).toHaveBeenCalledWith(
                expect.stringContaining("/association-set/leaves?chainId=1"),
                expect.objectContaining({ cache: "no-store" }),
            );
        });

        it("throw ASPUnavailable on error", async () => {
            vi.mocked(mockHttpClient.get).mockRejectedValue(new Error("Internal Server Error"));
            const provider = new HttpASPDataProvider(validConfig());
            await expect(provider.getLeaves()).rejects.toThrow(ASPUnavailable);
        });
    });

    describe("getLabelStatus", () => {
        it("return status from ASP API", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                status: "approved",
                timestamp: 1000,
            });
            const provider = new HttpASPDataProvider(validConfig());
            const status = await provider.getLabelStatus("0xabc" as Hash);
            expect(status.status).toBe("approved");
            expect(status.timestamp).toBe(1000);
        });

        it("handle all status values", async () => {
            for (const statusValue of [
                "pending",
                "approved",
                "rejected",
                "poi_required",
                "unknown",
            ] as const) {
                vi.mocked(mockHttpClient.get).mockResolvedValue({ status: statusValue });
                const provider = new HttpASPDataProvider(validConfig());
                const result = await provider.getLabelStatus("0xabc" as Hash);
                expect(result.status).toBe(statusValue);
            }
        });

        it("reject a status value outside the contract as ASPUnavailable", async () => {
            // The Zod guard is what turns an ASP vocabulary change into a skipped
            // label (kept PENDING, re-checked next scan) rather than trusted data.
            vi.mocked(mockHttpClient.get).mockResolvedValue({ status: "declined" });
            const provider = new HttpASPDataProvider(validConfig());
            await expect(provider.getLabelStatus("0xabc" as Hash)).rejects.toBeInstanceOf(
                ASPUnavailable,
            );
        });
    });

    describe("getASPPublicKey", () => {
        it("return public key from ASP API", async () => {
            const validKey = "0x" + "01".repeat(32);
            vi.mocked(mockHttpClient.get).mockResolvedValue({ publicKey: validKey });
            const provider = new HttpASPDataProvider(validConfig());
            const key = await provider.getASPPublicKey();
            expect(key).toBe(validKey);
        });

        it("throw ASPUnavailable on error", async () => {
            vi.mocked(mockHttpClient.get).mockRejectedValue(new Error("Network error"));
            const provider = new HttpASPDataProvider(validConfig());
            await expect(provider.getASPPublicKey()).rejects.toThrow(ASPUnavailable);
        });

        it("throw ASPUnavailable when response is missing the publicKey field", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({});
            const provider = new HttpASPDataProvider(validConfig());
            await expect(provider.getASPPublicKey()).rejects.toThrow(ASPUnavailable);
        });

        it("throw ASPUnavailable when publicKey is not a hex string", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({ publicKey: "not-hex" });
            const provider = new HttpASPDataProvider(validConfig());
            await expect(provider.getASPPublicKey()).rejects.toThrow(ASPUnavailable);
        });

        it("throw ASPUnavailable when publicKey is null", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({ publicKey: null });
            const provider = new HttpASPDataProvider(validConfig());
            await expect(provider.getASPPublicKey()).rejects.toThrow(ASPUnavailable);
        });
    });

    describe("getEventSnapshot", () => {
        const wirePayload = {
            chainId: "1",
            snapshotBlockNumber: "10000",
            generatedAt: "2026-05-06T00:00:00.000Z",
            deposits: [
                {
                    txHash: "0xa4dc425189ce55badcf529de9fac412ee7e539ed27b9a1c1b8b20fe8b2a8c330",
                    logIndex: 0,
                    depositAddress: "0xeca5cca87fdf2cb3f3a5d795699ceaa561c4b19d",
                    outputCommitment: "12345",
                    depositedValue: "1000000000000000000",
                    fee: "0",
                    blockNumber: "9999",
                    blockTimestamp: "2026-04-29T21:41:12.000Z",
                    asset: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                },
            ],
            transacts: [],
            ragequits: [],
            leaves: [],
            keystoreLeaves: [],
        };

        it("convert decimal-string fields to padded hex", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue(wirePayload);
            const provider = new HttpASPDataProvider(validConfig());
            const snapshot = await provider.getEventSnapshot();
            expect(snapshot.chainId).toBe(bigintToHex(1n));
            expect(snapshot.snapshotBlockNumber).toBe(bigintToHex(10000n));
            expect(snapshot.deposits[0]!.outputCommitment).toBe(bigintToHex(12345n));
            expect(snapshot.deposits[0]!.depositedValue).toBe(bigintToHex(1000000000000000000n));
            expect(snapshot.deposits[0]!.blockNumber).toBe(bigintToHex(9999n));
        });

        it("hit the chain-scoped event-snapshot endpoint", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue(wirePayload);
            const provider = new HttpASPDataProvider({ ...validConfig(), chainId: 11155111 });
            await provider.getEventSnapshot();
            expect(mockHttpClient.get).toHaveBeenCalledWith(
                expect.stringContaining("/11155111/public/event-snapshot/payload"),
                expect.objectContaining({ cache: "no-store" }),
            );
        });

        it("throw ASPUnavailable on fetch error", async () => {
            vi.mocked(mockHttpClient.get).mockRejectedValue(new Error("Network error"));
            const provider = new HttpASPDataProvider(validConfig());
            await expect(provider.getEventSnapshot()).rejects.toThrow(ASPUnavailable);
        });

        const wireTransact = (overrides?: Record<string, unknown>): Record<string, unknown> => ({
            txHash: `0x${"bb".repeat(32)}`,
            logIndex: 0,
            outputCommitments: ["777"],
            nullifierHashes: ["888"],
            caller: "0xeca5cca87fdf2cb3f3a5d795699ceaa561c4b19d",
            withdrawnValue: "0",
            encryptedPayload: `0x${"cc".repeat(40)}`,
            blockNumber: "9998",
            blockTimestamp: "2026-04-29T21:41:12.000Z",
            asset: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            ...overrides,
        });

        it("keep a spend row whose blockNumber is unusable", async () => {
            // The nullifiers identify the spend; the block is only the `spentAtBlock`
            // stamp, and the consumer falls back to the scan's own fromBlock. Dropping
            // the row would leave the note ACTIVE and invite the user to spend it twice
            // — and since the unreadable field is the one that locates the gap, it would
            // collapse coverage into a whole-range rescan as well.
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                ...wirePayload,
                transacts: [wireTransact({ blockNumber: null })],
            });
            const provider = new HttpASPDataProvider(validConfig());

            const snapshot = await provider.getEventSnapshot();

            expect(snapshot.transacts).toHaveLength(1);
            expect(snapshot.transacts[0]!.blockNumber).toBeNull();
            expect(snapshot.transacts[0]!.nullifierHashes).toEqual([bigintToHex(888n)]);
            expect(snapshot.drops).toBeUndefined();
        });

        it("keep a spend row whose blockNumber is unparseable", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                ...wirePayload,
                transacts: [wireTransact({ blockNumber: "not-a-number" })],
            });
            const provider = new HttpASPDataProvider(validConfig());

            const snapshot = await provider.getEventSnapshot();

            expect(snapshot.transacts).toHaveLength(1);
            expect(snapshot.transacts[0]!.blockNumber).toBeNull();
            expect(snapshot.drops).toBeUndefined();
        });

        it("drop a malformed row and keep the rest of the payload", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                ...wirePayload,
                transacts: [
                    wireTransact(),
                    // Unusable nullifier: a missed spend, so this row genuinely cannot be
                    // applied and coverage has to narrow around it.
                    wireTransact({ blockNumber: "12000", nullifierHashes: ["not-a-number"] }),
                ],
            });
            const provider = new HttpASPDataProvider(validConfig());

            const snapshot = await provider.getEventSnapshot();

            expect(snapshot.transacts).toHaveLength(1);
            expect(snapshot.transacts[0]!.blockNumber).toBe(bigintToHex(9998n));
            expect(snapshot.deposits).toHaveLength(1);
            expect(snapshot.drops).toEqual({
                transacts: { dropped: 1, earliestDroppedBlock: bigintToHex(12000n) },
            });
        });

        it("report the earliest dropped block per array", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                ...wirePayload,
                transacts: [
                    wireTransact({ blockNumber: "500", nullifierHashes: ["not-a-number"] }),
                    wireTransact({ blockNumber: "300", nullifierHashes: ["not-a-number"] }),
                    wireTransact(),
                ],
            });
            const provider = new HttpASPDataProvider(validConfig());

            const snapshot = await provider.getEventSnapshot();

            expect(snapshot.drops?.transacts).toEqual({
                dropped: 2,
                earliestDroppedBlock: bigintToHex(300n),
            });
        });

        it("report a null earliest block when a dropped row has no usable blockNumber", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                ...wirePayload,
                transacts: [
                    wireTransact({ blockNumber: "not-a-number", nullifierHashes: ["nope"] }),
                ],
            });
            const provider = new HttpASPDataProvider(validConfig());

            const snapshot = await provider.getEventSnapshot();

            expect(snapshot.drops?.transacts).toEqual({
                dropped: 1,
                earliestDroppedBlock: null,
            });
        });

        it("leave drops unset when every row validates", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue(wirePayload);
            const provider = new HttpASPDataProvider(validConfig());

            const snapshot = await provider.getEventSnapshot();

            expect(snapshot.drops).toBeUndefined();
        });

        it("warn about dropped rows without logging any field value", async () => {
            const logger = createMockLogger();
            const secretCommitment = "31337313373133731337";
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                ...wirePayload,
                transacts: [
                    wireTransact({
                        outputCommitments: [secretCommitment],
                        nullifierHashes: ["not-a-number"],
                    }),
                ],
            });
            const provider = new HttpASPDataProvider(validConfig(), { logger });

            await provider.getEventSnapshot();

            expect(logger.warn).toHaveBeenCalledTimes(1);
            const [message, context] = vi.mocked(logger.warn).mock.calls[0];
            expect(message).toContain("dropped 1 row(s)");
            // The warning must name the field, never carry ASP row data into whatever
            // sink the integrator wires the logger to.
            const serialized = `${message} ${JSON.stringify(context)}`;
            expect(serialized).toContain("transacts[0].nullifierHashes.0");
            expect(serialized).not.toContain(secretCommitment);
            expect(serialized).not.toContain(wirePayload.deposits[0]!.txHash);
        });

        it("warn about degraded rows even though no state was lost", async () => {
            // Nothing a consumer reads is gone and coverage is untouched, but this is the
            // first visible sign the ASP payload has drifted — staying silent means
            // finding out later from a null somewhere downstream.
            const logger = createMockLogger();
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                ...wirePayload,
                transacts: [wireTransact({ blockNumber: null })],
            });
            const provider = new HttpASPDataProvider(validConfig(), { logger });

            await provider.getEventSnapshot();

            expect(logger.warn).toHaveBeenCalledTimes(1);
            const [message, context] = vi.mocked(logger.warn).mock.calls[0];
            expect(message).toContain("dropped 0 row(s), degraded 1");
            expect(JSON.stringify(context)).toContain("degraded transacts[0].blockNumber");
        });

        it("throw ASPUnavailable when the envelope block number is unusable", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                ...wirePayload,
                snapshotBlockNumber: "not-a-number",
            });
            const provider = new HttpASPDataProvider(validConfig());

            await expect(provider.getEventSnapshot()).rejects.toThrow(ASPUnavailable);
        });

        it("throw ASPUnavailable when a row array is missing entirely", async () => {
            // Absent is a claim ("nothing was spent"), not a gap — per-row tolerance
            // must not extend to a whole array going missing.
            const { transacts: _omitted, ...withoutTransacts } = wirePayload;
            vi.mocked(mockHttpClient.get).mockResolvedValue(withoutTransacts);
            const provider = new HttpASPDataProvider(validConfig());

            await expect(provider.getEventSnapshot()).rejects.toThrow(ASPUnavailable);
        });
    });

    describe("getNoteEvents", () => {
        const validEvent = (overrides?: Record<string, unknown>): Record<string, unknown> => ({
            blockNumber: "100",
            txHash: `0x${"11".repeat(32)}`,
            hint: `0x${"22".repeat(32)}`,
            ephemeralPubKey: `0x${"33".repeat(32)}`,
            encryptedPayload: `0x${"44".repeat(40)}`,
            ...overrides,
        });

        it("drop events with an empty encryptedPayload and keep the valid ones", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                events: [
                    validEvent(),
                    validEvent({ encryptedPayload: "0x" }),
                    validEvent({ encryptedPayload: "" }),
                ],
                lastSyncedBlock: "0x100",
            });
            const provider = new HttpASPDataProvider(validConfig());

            const result = await provider.getNoteEvents();

            expect(result.events).toHaveLength(1);
            expect(result.events[0]!.encryptedPayload).toBe(`0x${"44".repeat(40)}`);
        });

        it("emit a single warning naming the dropped count", async () => {
            const logger = createMockLogger();
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                events: [
                    validEvent(),
                    validEvent({ encryptedPayload: "0x" }),
                    validEvent({ encryptedPayload: "0x" }),
                ],
                lastSyncedBlock: "0x100",
            });
            const provider = new HttpASPDataProvider(validConfig(), { logger });

            await provider.getNoteEvents();

            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain("Dropped 2");
        });

        it("not warn when every event has a payload", async () => {
            const logger = createMockLogger();
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                events: [validEvent()],
                lastSyncedBlock: "0x100",
            });
            const provider = new HttpASPDataProvider(validConfig(), { logger });

            await provider.getNoteEvents();

            expect(logger.warn).not.toHaveBeenCalled();
        });

        it("throw ASPUnavailable when a non-empty event is genuinely malformed", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                events: [validEvent({ txHash: "not-hex" })],
                lastSyncedBlock: "0x100",
            });
            const provider = new HttpASPDataProvider(validConfig());

            await expect(provider.getNoteEvents()).rejects.toThrow(ASPUnavailable);
        });
    });
});
