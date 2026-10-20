import { encodeAbiParameters, encodeEventTopics } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    FinalizedBlockResult,
    Hash,
    Hex,
    IRPCInteractor,
    TxLog,
} from "../../../src/internal.js";
import {
    bigintToHex,
    ContractCallError,
    InvalidHashArgument,
    InvalidInteractorAddress,
    POOL_VAULT_TRANSACTED_EVENT_ABI,
    createEvmPoolVaultInteractor,
    PoolVaultInteractor,
} from "../../../src/internal.js";

const VALID_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VALID_HASH = "0x00000000000000000000000000000000000000000000000000000000deadbeef" as Hash;

function createMockRPC(readContractImpl?: IRPCInteractor["readContract"]): IRPCInteractor {
    return {
        readContract: vi.fn(readContractImpl ?? (async (): Promise<bigint> => 0n)),
        getLogs: vi.fn(async () => []),
        getLogsPaginated: vi.fn(async () => []),
        getBlockNumber: vi.fn(async () => "0x0"),
        getFinalizedBlockNumber: vi.fn(
            async () => ({ status: "unsupported" }) as FinalizedBlockResult,
        ),
        waitForTransactionReceipt: vi.fn(),
    };
}

describe("PoolVaultInteractor", () => {
    let mockRPC: IRPCInteractor;
    let interactor: PoolVaultInteractor;

    beforeEach(() => {
        mockRPC = createMockRPC();
        interactor = createEvmPoolVaultInteractor({
            rpcInteractor: mockRPC,
            contractAddress: VALID_ADDRESS,
        });
    });

    describe("constructor", () => {
        it("create instance with valid config", () => {
            expect(interactor).toBeInstanceOf(PoolVaultInteractor);
        });

        it("reject invalid contract address", () => {
            expect(
                () =>
                    createEvmPoolVaultInteractor({
                        rpcInteractor: mockRPC,
                        contractAddress: "not-hex" as Address,
                    }),
            ).toThrow(InvalidInteractorAddress);
        });
    });

    describe("getCommitmentTimestamp", () => {
        it("return the commitment timestamp", async () => {
            mockRPC = createMockRPC(async () => 1700000000n);
            interactor = createEvmPoolVaultInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getCommitmentTimestamp(VALID_HASH);

            expect(result).toBe(
                "0x000000000000000000000000000000000000000000000000000000006553f100",
            );
            expect(mockRPC.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "commitments",
                    args: [BigInt(VALID_HASH)],
                }),
            );
        });

        it("return 0n for non-existent commitment", async () => {
            mockRPC = createMockRPC(async () => 0n);
            interactor = createEvmPoolVaultInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getCommitmentTimestamp(VALID_HASH);

            expect(result).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            );
        });

        it("reject invalid hex hash", async () => {
            await expect(interactor.getCommitmentTimestamp("not-hex" as Hash)).rejects.toThrow(
                InvalidHashArgument,
            );
        });

        it("wrap RPC errors in ContractCallError", async () => {
            mockRPC = createMockRPC(async () => {
                throw new Error("execution reverted");
            });
            interactor = createEvmPoolVaultInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.getCommitmentTimestamp(VALID_HASH)).rejects.toThrow(
                ContractCallError,
            );
        });
    });

    describe("getNullifierTimestamp", () => {
        it("return the nullifier timestamp", async () => {
            mockRPC = createMockRPC(async () => 1700000000n);
            interactor = createEvmPoolVaultInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getNullifierTimestamp(VALID_HASH);

            expect(result).toBe(
                "0x000000000000000000000000000000000000000000000000000000006553f100",
            );
            expect(mockRPC.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "spentNullifiers",
                    args: [BigInt(VALID_HASH)],
                }),
            );
        });

        it("return 0n for unspent nullifier", async () => {
            mockRPC = createMockRPC(async () => 0n);
            interactor = createEvmPoolVaultInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getNullifierTimestamp(VALID_HASH);

            expect(result).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            );
        });

        it("reject invalid hex hash", async () => {
            await expect(interactor.getNullifierTimestamp("bad" as Hash)).rejects.toThrow(
                InvalidHashArgument,
            );
        });

        it("wrap RPC errors in ContractCallError", async () => {
            mockRPC = createMockRPC(async () => {
                throw new Error("timeout");
            });
            interactor = createEvmPoolVaultInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.getNullifierTimestamp(VALID_HASH)).rejects.toThrow(
                ContractCallError,
            );
        });
    });

    describe("isKnownRoot", () => {
        it("return true for a known root", async () => {
            mockRPC = createMockRPC(async () => true);
            interactor = createEvmPoolVaultInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.isKnownRoot(VALID_HASH);

            expect(result).toBe(true);
            expect(mockRPC.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "isKnownRoot",
                    args: [BigInt(VALID_HASH)],
                }),
            );
        });

        it("return false for an unknown root", async () => {
            mockRPC = createMockRPC(async () => false);
            interactor = createEvmPoolVaultInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.isKnownRoot(VALID_HASH);

            expect(result).toBe(false);
        });

        it("reject invalid hex hash", async () => {
            await expect(interactor.isKnownRoot("xyz" as Hash)).rejects.toThrow(
                InvalidHashArgument,
            );
        });

        it("wrap RPC errors in ContractCallError", async () => {
            mockRPC = createMockRPC(async () => {
                throw new Error("reverted");
            });
            interactor = createEvmPoolVaultInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.isKnownRoot(VALID_HASH)).rejects.toThrow(ContractCallError);
        });
    });

    describe("getStateLeaves / leaf cache seeding", () => {
        it("exportLeafCache returns undefined before any fetch", () => {
            expect(interactor.exportLeafCache()).toBeUndefined();
        });

        it("exportLeafCache returns the current cache after a fetch", async () => {
            mockRPC = createMockRPC();
            mockRPC.getLogsPaginated = vi.fn(async () => [
                {
                    eventName: "LeavesInserted",
                    args: { _newLeaves: [0xaaan], _root: 0n, _startIndex: 0n },
                    blockNumber: "0x0" as Hex,
                    transactionHash: VALID_HASH,
                },
            ]);
            interactor = createEvmPoolVaultInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await interactor.getStateLeaves();
            const seed = interactor.exportLeafCache();

            expect(seed).toBeDefined();
            expect(seed?.toBlock).toBe(0n);
            expect(seed?.leaves).toEqual([
                "0x0000000000000000000000000000000000000000000000000000000000000aaa",
            ]);
        });

        it("a seed pre-populates the cache and getStateLeaves skips scanning already-covered blocks", async () => {
            const getLogsPaginated = vi.fn(async () => []);
            mockRPC = createMockRPC();
            mockRPC.getLogsPaginated = getLogsPaginated;
            mockRPC.getBlockNumber = vi.fn(async () => "0x5");

            const seededLeaves: Hash[] = [
                "0x0000000000000000000000000000000000000000000000000000000000000aaa",
            ];
            interactor = createEvmPoolVaultInteractor(
                { rpcInteractor: mockRPC, contractAddress: VALID_ADDRESS },
                { seed: { toBlock: 5n, leaves: seededLeaves } },
            );

            const leaves = await interactor.getStateLeaves();

            expect(leaves).toEqual(seededLeaves);
            expect(getLogsPaginated).not.toHaveBeenCalled();
        });

        it("a seed makes getStateLeaves a delta-fetch from seed.toBlock + 1", async () => {
            const getLogsPaginated = vi.fn(async () => [
                {
                    eventName: "LeavesInserted",
                    args: { _newLeaves: [0xbbbn], _root: 0n, _startIndex: 1n },
                    blockNumber: "0xa" as Hex,
                    transactionHash: VALID_HASH,
                },
            ]);
            mockRPC = createMockRPC();
            mockRPC.getLogsPaginated = getLogsPaginated;
            mockRPC.getBlockNumber = vi.fn(async () => "0xa");

            const seededLeaves: Hash[] = [
                "0x0000000000000000000000000000000000000000000000000000000000000aaa",
            ];
            interactor = createEvmPoolVaultInteractor(
                { rpcInteractor: mockRPC, contractAddress: VALID_ADDRESS },
                { seed: { toBlock: 5n, leaves: seededLeaves } },
            );

            const leaves = await interactor.getStateLeaves();

            expect(getLogsPaginated).toHaveBeenCalledWith(
                expect.objectContaining({ fromBlock: 6n, toBlock: 10n }),
            );
            expect(leaves).toEqual([
                "0x0000000000000000000000000000000000000000000000000000000000000aaa",
                "0x0000000000000000000000000000000000000000000000000000000000000bbb",
            ]);
        });
    });

    describe("getTransactedEvents", () => {
        const TX_HASH =
            "0xabc0000000000000000000000000000000000000000000000000000000000001" as Hash;
        const ASSET_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
        const CALLER_ADDRESS = "0x1111111111111111111111111111111111111111" as Address;

        function makeTransactedLog(overrides?: {
            blockNumber?: bigint;
            txHash?: Hash;
            outputCommitments?: bigint[];
            nullifierHashes?: bigint[];
            asset?: Address;
            withdrawnValue?: bigint;
            caller?: Address;
            eventName?: string;
        }): unknown {
            return {
                blockNumber: overrides?.blockNumber ?? 100n,
                transactionHash: overrides?.txHash ?? TX_HASH,
                eventName: overrides?.eventName ?? "Transacted",
                args: {
                    outputCommitments: overrides?.outputCommitments ?? [1n, 2n],
                    nullifierHashes: overrides?.nullifierHashes ?? [3n, 4n],
                    asset: overrides?.asset ?? ASSET_ADDRESS,
                    withdrawnValue: overrides?.withdrawnValue ?? 1000n,
                    caller: overrides?.caller ?? CALLER_ADDRESS,
                },
            };
        }

        function buildInteractorWithLogs(logs: unknown[]): PoolVaultInteractor {
            const rpc: IRPCInteractor = {
                readContract: vi.fn(),
                getLogs: vi.fn(async () => logs) as IRPCInteractor["getLogs"],
                getLogsPaginated: vi.fn(async () => logs) as IRPCInteractor["getLogsPaginated"],
                getBlockNumber: vi.fn(async () => "0x0"),
                getFinalizedBlockNumber: vi.fn(
                    async () => ({ status: "unsupported" }) as FinalizedBlockResult,
                ),
                waitForTransactionReceipt: vi.fn(),
            };
            return createEvmPoolVaultInteractor({
                rpcInteractor: rpc,
                contractAddress: VALID_ADDRESS,
            });
        }

        it("return empty array when there are no logs", async () => {
            const events = await interactor.getTransactedEvents();
            expect(events).toEqual([]);
        });

        it("parse a single Transacted event into a TransactedEvent", async () => {
            const svc = buildInteractorWithLogs([makeTransactedLog()]);

            const events = await svc.getTransactedEvents();

            expect(events).toHaveLength(1);
            expect(events[0]).toEqual({
                blockNumber: 100n,
                txHash: TX_HASH,
                outputCommitments: [
                    "0x0000000000000000000000000000000000000000000000000000000000000001",
                    "0x0000000000000000000000000000000000000000000000000000000000000002",
                ],
                nullifierHashes: [
                    "0x0000000000000000000000000000000000000000000000000000000000000003",
                    "0x0000000000000000000000000000000000000000000000000000000000000004",
                ],
                asset: ASSET_ADDRESS,
                withdrawnValue:
                    "0x00000000000000000000000000000000000000000000000000000000000003e8",
                caller: CALLER_ADDRESS,
            });
        });

        it("forward fromBlock and toBlock to getLogs as bigints", async () => {
            const getLogs: IRPCInteractor["getLogs"] = vi.fn(async () => []);
            const svc = createEvmPoolVaultInteractor({
                rpcInteractor: {
                    readContract: vi.fn(),
                    getLogs,
                    getLogsPaginated: getLogs as IRPCInteractor["getLogsPaginated"],
                    getBlockNumber: vi.fn(async () => "0x0"),
                    getFinalizedBlockNumber: vi.fn(
                        async () => ({ status: "unsupported" }) as FinalizedBlockResult,
                    ),
                    waitForTransactionReceipt: vi.fn(),
                },
                contractAddress: VALID_ADDRESS,
            });

            await svc.getTransactedEvents("0xa" as Hex, "0x14" as Hex);

            expect(getLogs).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: VALID_ADDRESS,
                    fromBlock: 10n,
                    toBlock: 20n,
                }),
            );
        });

        it("skip logs whose eventName is not Transacted", async () => {
            const svc = buildInteractorWithLogs([
                makeTransactedLog({ eventName: "Note" }),
                makeTransactedLog({ blockNumber: 200n }),
            ]);

            const events = await svc.getTransactedEvents();

            expect(events).toHaveLength(1);
            expect(events[0].blockNumber).toBe(200n);
        });

        it("skip malformed Transacted logs without throwing", async () => {
            const svc = buildInteractorWithLogs([
                {
                    blockNumber: 100n,
                    transactionHash: TX_HASH,
                    eventName: "Transacted",
                    args: { outputCommitments: "not-an-array" },
                },
                makeTransactedLog({ blockNumber: 300n }),
            ]);

            const events = await svc.getTransactedEvents();

            expect(events).toHaveLength(1);
            expect(events[0].blockNumber).toBe(300n);
        });

        it("wrap RPC errors in ContractCallError", async () => {
            const failingRPC: IRPCInteractor = {
                readContract: vi.fn(),
                getLogs: vi.fn(async () => {
                    throw new Error("RPC unavailable");
                }),
                getLogsPaginated: vi.fn(async () => {
                    throw new Error("RPC unavailable");
                }),
                getBlockNumber: vi.fn(async () => "0x0"),
                getFinalizedBlockNumber: vi.fn(
                    async () => ({ status: "unsupported" }) as FinalizedBlockResult,
                ),
                waitForTransactionReceipt: vi.fn(),
            };
            const svc = createEvmPoolVaultInteractor({
                rpcInteractor: failingRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(svc.getTransactedEvents()).rejects.toThrow(ContractCallError);
        });

        it("parse multiple Transacted events", async () => {
            const svc = buildInteractorWithLogs([
                makeTransactedLog({ blockNumber: 10n }),
                makeTransactedLog({ blockNumber: 20n }),
                makeTransactedLog({ blockNumber: 30n }),
            ]);

            const events = await svc.getTransactedEvents();

            expect(events).toHaveLength(3);
            expect(events.map((e) => e.blockNumber)).toEqual([10n, 20n, 30n]);
        });
    });

    describe("getRagequitEvents", () => {
        const TX_HASH =
            "0xabc0000000000000000000000000000000000000000000000000000000000002" as Hash;
        const RAGEQUITTER = "0x2222222222222222222222222222222222222222" as Address;
        const RAGEQUIT_ASSET = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;

        function makeRagequitLog(overrides?: {
            blockNumber?: bigint;
            txHash?: Hash;
            ragequitter?: Address;
            asset?: Address;
            value?: bigint;
            commitment?: bigint;
            nullifierHash?: bigint;
            label?: bigint;
            eventName?: string;
        }): unknown {
            return {
                blockNumber: overrides?.blockNumber ?? 100n,
                transactionHash: overrides?.txHash ?? TX_HASH,
                eventName: overrides?.eventName ?? "Ragequit",
                args: {
                    ragequitter: overrides?.ragequitter ?? RAGEQUITTER,
                    asset: overrides?.asset ?? RAGEQUIT_ASSET,
                    // value field is emitted on-chain but not parsed by the SDK
                    value: overrides?.value ?? 5000n,
                    commitment: overrides?.commitment ?? 11n,
                    nullifierHash: overrides?.nullifierHash ?? 22n,
                    label: overrides?.label ?? 33n,
                },
            };
        }

        function buildInteractorWithLogs(logs: unknown[]): PoolVaultInteractor {
            const rpc: IRPCInteractor = {
                readContract: vi.fn(),
                getLogs: vi.fn(async () => logs) as IRPCInteractor["getLogs"],
                getLogsPaginated: vi.fn(async () => logs) as IRPCInteractor["getLogsPaginated"],
                getBlockNumber: vi.fn(async () => "0x0"),
                getFinalizedBlockNumber: vi.fn(
                    async () => ({ status: "unsupported" }) as FinalizedBlockResult,
                ),
                waitForTransactionReceipt: vi.fn(),
            };
            return createEvmPoolVaultInteractor({
                rpcInteractor: rpc,
                contractAddress: VALID_ADDRESS,
            });
        }

        it("return empty array when there are no logs", async () => {
            const events = await interactor.getRagequitEvents();
            expect(events).toEqual([]);
        });

        it("parse a single Ragequit event into a RagequitEvent", async () => {
            const svc = buildInteractorWithLogs([makeRagequitLog()]);

            const events = await svc.getRagequitEvents();

            expect(events).toHaveLength(1);
            expect(events[0]).toEqual({
                blockNumber: 100n,
                txHash: TX_HASH,
                ragequitter: RAGEQUITTER,
                asset: RAGEQUIT_ASSET,
                commitment: "0x000000000000000000000000000000000000000000000000000000000000000b",
                nullifierHash: "0x0000000000000000000000000000000000000000000000000000000000000016",
                label: "0x0000000000000000000000000000000000000000000000000000000000000021",
            });
        });

        it("forward fromBlock and toBlock to getLogs as bigints", async () => {
            const getLogs: IRPCInteractor["getLogs"] = vi.fn(async () => []);
            const svc = createEvmPoolVaultInteractor({
                rpcInteractor: {
                    readContract: vi.fn(),
                    getLogs,
                    getLogsPaginated: getLogs as IRPCInteractor["getLogsPaginated"],
                    getBlockNumber: vi.fn(async () => "0x0"),
                    getFinalizedBlockNumber: vi.fn(
                        async () => ({ status: "unsupported" }) as FinalizedBlockResult,
                    ),
                    waitForTransactionReceipt: vi.fn(),
                },
                contractAddress: VALID_ADDRESS,
            });

            await svc.getRagequitEvents("0x5" as Hex, "0xf" as Hex);

            expect(getLogs).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: VALID_ADDRESS,
                    fromBlock: 5n,
                    toBlock: 15n,
                }),
            );
        });

        it("skip logs whose eventName is not Ragequit", async () => {
            const svc = buildInteractorWithLogs([
                makeRagequitLog({ eventName: "Note" }),
                makeRagequitLog({ blockNumber: 250n }),
            ]);

            const events = await svc.getRagequitEvents();

            expect(events).toHaveLength(1);
            expect(events[0].blockNumber).toBe(250n);
        });

        it("skip malformed Ragequit logs without throwing", async () => {
            const svc = buildInteractorWithLogs([
                {
                    blockNumber: 100n,
                    transactionHash: TX_HASH,
                    eventName: "Ragequit",
                    args: { ragequitter: "not-an-address" },
                },
                makeRagequitLog({ blockNumber: 400n }),
            ]);

            const events = await svc.getRagequitEvents();

            expect(events).toHaveLength(1);
            expect(events[0].blockNumber).toBe(400n);
        });

        it("wrap RPC errors in ContractCallError", async () => {
            const failingRPC: IRPCInteractor = {
                readContract: vi.fn(),
                getLogs: vi.fn(async () => {
                    throw new Error("RPC unavailable");
                }),
                getLogsPaginated: vi.fn(async () => {
                    throw new Error("RPC unavailable");
                }),
                getBlockNumber: vi.fn(async () => "0x0"),
                getFinalizedBlockNumber: vi.fn(
                    async () => ({ status: "unsupported" }) as FinalizedBlockResult,
                ),
                waitForTransactionReceipt: vi.fn(),
            };
            const svc = createEvmPoolVaultInteractor({
                rpcInteractor: failingRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(svc.getRagequitEvents()).rejects.toThrow(ContractCallError);
        });

        it("parse multiple Ragequit events", async () => {
            const svc = buildInteractorWithLogs([
                makeRagequitLog({ blockNumber: 10n }),
                makeRagequitLog({ blockNumber: 20n }),
                makeRagequitLog({ blockNumber: 30n }),
            ]);

            const events = await svc.getRagequitEvents();

            expect(events).toHaveLength(3);
            expect(events.map((e) => e.blockNumber)).toEqual([10n, 20n, 30n]);
        });
    });
});

// --- extractSpentNullifiers (AW-L-02 / #1070 receipt log verification) ---

const OTHER_CONTRACT = "0x9999999999999999999999999999999999999999" as Address;
const EVENT_ASSET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const EVENT_CALLER = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;

/**
 * Builds a realistic raw `Transacted` receipt log (indexed asset/caller in topics,
 * non-indexed outputCommitments/nullifierHashes/withdrawnValue in data) exactly as an
 * EVM node emits it — so `extractSpentNullifiers` runs the real viem decode path.
 */
function makeTransactedLog(opts: {
    nullifierHashes: bigint[];
    address?: Address;
    outputCommitments?: bigint[];
    withdrawnValue?: bigint;
}): TxLog {
    const topics = encodeEventTopics({
        abi: POOL_VAULT_TRANSACTED_EVENT_ABI,
        eventName: "Transacted",
        args: { asset: EVENT_ASSET, caller: EVENT_CALLER },
    }) as Hex[];
    const data = encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256" }],
        [opts.outputCommitments ?? [], opts.nullifierHashes, opts.withdrawnValue ?? 0n],
    );
    return {
        address: opts.address ?? VALID_ADDRESS,
        topics,
        data,
        blockNumber: "0x1" as Hex,
        transactionHash: "0xabc" as Hex,
        logIndex: 0,
    };
}

describe("PoolVaultInteractor.extractSpentNullifiers", () => {
    let interactor: PoolVaultInteractor;

    beforeEach(() => {
        interactor = createEvmPoolVaultInteractor({
            rpcInteractor: createMockRPC(),
            contractAddress: VALID_ADDRESS,
        });
    });

    it("extract nullifier hashes from a pool-emitted Transacted log", () => {
        const log = makeTransactedLog({ nullifierHashes: [0xdeadn, 0xbeefn] });

        expect(interactor.extractSpentNullifiers([log])).toEqual([
            bigintToHex(0xdeadn),
            bigintToHex(0xbeefn),
        ]);
    });

    it("ignore a Transacted log emitted by a contract other than the PoolVault", () => {
        // Emitter==pool gate: a relayer could return a receipt whose Transacted log comes
        // from an unrelated contract; those nullifiers must not count.
        const log = makeTransactedLog({ nullifierHashes: [0xdeadn], address: OTHER_CONTRACT });

        expect(interactor.extractSpentNullifiers([log])).toEqual([]);
    });

    it("aggregate nullifiers across multiple pool Transacted logs (batch)", () => {
        const logs = [
            makeTransactedLog({ nullifierHashes: [0x1n] }),
            makeTransactedLog({ nullifierHashes: [0x2n, 0x3n] }),
        ];

        expect(interactor.extractSpentNullifiers(logs)).toEqual([
            bigintToHex(0x1n),
            bigintToHex(0x2n),
            bigintToHex(0x3n),
        ]);
    });

    it("skip a pool log that is not a Transacted event", () => {
        const foreign: TxLog = {
            address: VALID_ADDRESS,
            topics: [("0x" + "11".repeat(32)) as Hex],
            data: "0x" as Hex,
            blockNumber: "0x1" as Hex,
            transactionHash: "0xabc" as Hex,
            logIndex: 1,
        };

        expect(interactor.extractSpentNullifiers([foreign])).toEqual([]);
    });

    it("return empty for a receipt with no logs", () => {
        expect(interactor.extractSpentNullifiers([])).toEqual([]);
    });

    it("keep only the pool's nullifiers when pool and foreign Transacted logs are mixed", () => {
        const logs = [
            makeTransactedLog({ nullifierHashes: [0xaaan], address: OTHER_CONTRACT }),
            makeTransactedLog({ nullifierHashes: [0xbbbn] }),
        ];

        expect(interactor.extractSpentNullifiers(logs)).toEqual([bigintToHex(0xbbbn)]);
    });
});
