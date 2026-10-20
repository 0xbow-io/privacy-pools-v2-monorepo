import type { Abi, PublicClient } from "viem";
import { sepolia } from "viem/chains";
import { describe, expect, it, vi } from "vitest";

import type { Address, Hex } from "../../../src/internal.js";
import {
    ContractReadError,
    EventReadError,
    GetBlockNumberError,
    InvalidABIFunctionName,
    InvalidChain,
    InvalidContractAddress,
    InvalidRpcUrl,
    InvalidViemRPCInteractorConfig,
    ViemRPCInteractor,
    WaitForReceiptError,
} from "../../../src/internal.js";

const TEST_ABI = [
    {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
] as const satisfies Abi;

const TEST_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VALID_TX_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

describe("ViemRPCInteractor", () => {
    function createMockClient(overrides?: {
        readContract?: (...args: unknown[]) => Promise<unknown>;
        getBlockNumber?: () => Promise<bigint>;
        waitForTransactionReceipt?: (...args: unknown[]) => Promise<unknown>;
        getLogs?: (...args: unknown[]) => unknown;
    }): PublicClient {
        return {
            readContract: vi.fn(overrides?.readContract ?? (async (): Promise<bigint> => 100n)),
            getBlockNumber: vi.fn(
                overrides?.getBlockNumber ?? (async (): Promise<bigint> => 123456n),
            ),
            waitForTransactionReceipt: vi.fn(
                overrides?.waitForTransactionReceipt ??
                    (async (): Promise<unknown> => ({
                        status: "success",
                        blockNumber: 100n,
                        logs: [],
                    })),
            ),
            getLogs: vi.fn(overrides?.getLogs ?? (async (): Promise<never[]> => [])),
        } as unknown as PublicClient;
    }

    describe("create", () => {
        it("create instance with rpcUrl only", () => {
            const interactor = ViemRPCInteractor.create({ rpcUrl: "https://eth.llamarpc.com" });
            expect(interactor).toBeInstanceOf(ViemRPCInteractor);
        });

        it("create instance with rpcUrl and chain", () => {
            const interactor = ViemRPCInteractor.create({
                rpcUrl: "https://eth.llamarpc.com",
                chain: sepolia,
            });
            expect(interactor).toBeInstanceOf(ViemRPCInteractor);
        });
    });

    describe("create validation", () => {
        it("reject invalid RPC URL", () => {
            expect(() => ViemRPCInteractor.create({ rpcUrl: "not-a-url" })).toThrow(InvalidRpcUrl);
        });

        it("reject RPC URL with unsupported protocol (ftp://)", () => {
            expect(() => ViemRPCInteractor.create({ rpcUrl: "ftp://example.com/rpc" })).toThrow(
                InvalidRpcUrl,
            );
        });

        it("accept http and https URLs", () => {
            expect(() =>
                ViemRPCInteractor.create({ rpcUrl: "http://localhost:8545" }),
            ).not.toThrow();
            expect(() =>
                ViemRPCInteractor.create({ rpcUrl: "https://eth.llamarpc.com" }),
            ).not.toThrow();
        });

        it("reject ws and wss URLs (create only builds an http transport)", () => {
            expect(() => ViemRPCInteractor.create({ rpcUrl: "ws://localhost:8546" })).toThrow(
                InvalidRpcUrl,
            );
            expect(() => ViemRPCInteractor.create({ rpcUrl: "wss://eth.llamarpc.com/ws" })).toThrow(
                InvalidRpcUrl,
            );
        });

        it("reject chain with non-positive id", () => {
            expect(() =>
                ViemRPCInteractor.create({
                    rpcUrl: "https://eth.llamarpc.com",
                    chain: { id: -1, name: "bad" } as never,
                }),
            ).toThrow(InvalidChain);
        });

        it("reject chain with empty name", () => {
            expect(() =>
                ViemRPCInteractor.create({
                    rpcUrl: "https://eth.llamarpc.com",
                    chain: { id: sepolia.id, name: "" } as never,
                }),
            ).toThrow(InvalidChain);
        });

        it("reject unsupported chain ID", () => {
            expect(() =>
                ViemRPCInteractor.create({
                    rpcUrl: "https://eth.llamarpc.com",
                    chain: { id: 999999, name: "unknown" } as never,
                }),
            ).toThrow(InvalidChain);
        });

        it("accept sepolia chain", () => {
            expect(() =>
                ViemRPCInteractor.create({
                    rpcUrl: "https://eth.llamarpc.com",
                    chain: sepolia,
                }),
            ).not.toThrow();
        });

        it("accept undefined chain", () => {
            expect(() =>
                ViemRPCInteractor.create({ rpcUrl: "https://eth.llamarpc.com" }),
            ).not.toThrow();
        });
    });

    describe("constructor", () => {
        it("accept config with publicClient", () => {
            const client = createMockClient();
            const interactor = new ViemRPCInteractor({ publicClient: client });
            expect(interactor).toBeInstanceOf(ViemRPCInteractor);
        });

        it("accept a positive chunkSize override", () => {
            const client = createMockClient();
            expect(
                () => new ViemRPCInteractor({ publicClient: client, chunkSize: 5_000n }),
            ).not.toThrow();
        });

        it("throw InvalidViemRPCInteractorConfig when chunkSize is zero", () => {
            const client = createMockClient();
            expect(() => new ViemRPCInteractor({ publicClient: client, chunkSize: 0n })).toThrow(
                InvalidViemRPCInteractorConfig,
            );
        });

        it("throw InvalidViemRPCInteractorConfig when chunkSize is negative", () => {
            const client = createMockClient();
            expect(() => new ViemRPCInteractor({ publicClient: client, chunkSize: -1n })).toThrow(
                InvalidViemRPCInteractorConfig,
            );
        });
    });

    describe("readContract", () => {
        it("delegate to publicClient.readContract with correct params", async () => {
            const client = createMockClient({ readContract: async () => 42n });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            const params = {
                address: TEST_ADDRESS,
                abi: TEST_ABI,
                functionName: "balanceOf" as const,
                args: [TEST_ADDRESS],
            };

            const result = await interactor.readContract(params);

            expect(result).toBe(42n);
            expect(client.readContract).toHaveBeenCalledOnce();
            expect(client.readContract).toHaveBeenCalledWith(params);
        });

        it("return the value from publicClient.readContract", async () => {
            const client = createMockClient({ readContract: async () => 0n });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            const result = await interactor.readContract({
                address: TEST_ADDRESS,
                abi: TEST_ABI,
                functionName: "balanceOf" as const,
                args: [TEST_ADDRESS],
            });

            expect(result).toBe(0n);
        });
    });

    describe("readContract validation", () => {
        it("reject invalid address (not hex)", async () => {
            const client = createMockClient();
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await expect(
                interactor.readContract({
                    address: "not-an-address" as Address,
                    abi: TEST_ABI,
                    functionName: "balanceOf" as const,
                    args: [TEST_ADDRESS],
                }),
            ).rejects.toThrow(InvalidContractAddress);
        });

        it("reject address with wrong length (too short)", async () => {
            const client = createMockClient();
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await expect(
                interactor.readContract({
                    address: "0x1234" as Address,
                    abi: TEST_ABI,
                    functionName: "balanceOf" as const,
                    args: [TEST_ADDRESS],
                }),
            ).rejects.toThrow(InvalidContractAddress);
        });

        it("reject function name not in ABI", async () => {
            const client = createMockClient();
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await expect(
                interactor.readContract({
                    address: TEST_ADDRESS,
                    abi: TEST_ABI,
                    functionName: "nonExistentFunction",
                    args: [],
                }),
            ).rejects.toThrow(InvalidABIFunctionName);
        });

        it("include function name in error message", async () => {
            const client = createMockClient();
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await expect(
                interactor.readContract({
                    address: TEST_ADDRESS,
                    abi: TEST_ABI,
                    functionName: "missingFn",
                    args: [],
                }),
            ).rejects.toThrow('Function "missingFn" not found in provided ABI');
        });
    });

    describe("readContract error handling", () => {
        it("preserves the original error as the ContractReadError cause", async () => {
            const original = new Error("RPC timeout");
            const client = createMockClient({
                readContract: async () => {
                    throw original;
                },
            });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            const error = await interactor
                .readContract({
                    address: TEST_ADDRESS,
                    abi: TEST_ABI,
                    functionName: "balanceOf",
                    args: [TEST_ADDRESS],
                })
                .catch((failure: unknown) => failure);
            expect(error).toBeInstanceOf(ContractReadError);
            expect((error as ContractReadError).cause).toBe(original);
        });

        it("wrap Error instances in ContractReadError", async () => {
            const client = createMockClient({
                readContract: async () => {
                    throw new Error("execution reverted");
                },
            });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await expect(
                interactor.readContract({
                    address: TEST_ADDRESS,
                    abi: TEST_ABI,
                    functionName: "balanceOf" as const,
                    args: [TEST_ADDRESS],
                }),
            ).rejects.toThrow(ContractReadError);
        });

        it("preserve the original error message in ContractReadError", async () => {
            const client = createMockClient({
                readContract: async () => {
                    throw new Error("execution reverted");
                },
            });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await expect(
                interactor.readContract({
                    address: TEST_ADDRESS,
                    abi: TEST_ABI,
                    functionName: "balanceOf" as const,
                    args: [TEST_ADDRESS],
                }),
            ).rejects.toThrow("Contract read failed: execution reverted");
        });

        it("wrap non-Error values in ContractReadError", async () => {
            const client = createMockClient({
                readContract: async () => {
                    throw "raw string error";
                },
            });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await expect(
                interactor.readContract({
                    address: TEST_ADDRESS,
                    abi: TEST_ABI,
                    functionName: "balanceOf" as const,
                    args: [TEST_ADDRESS],
                }),
            ).rejects.toThrow("Contract read failed: raw string error");
        });
    });

    describe("getBlockNumber", () => {
        it("return block number as Hex", async () => {
            const client = createMockClient({ getBlockNumber: async () => 123456n });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            const result = await interactor.getBlockNumber();

            expect(result).toBe("0x1e240");
        });

        it("bypass viem's block-number cache so scans see the current head", async () => {
            const client = createMockClient();
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await interactor.getBlockNumber();

            expect(client.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
        });

        it("throw GetBlockNumberError on RPC failure", async () => {
            const client = createMockClient({
                getBlockNumber: async () => {
                    throw new Error("RPC timeout");
                },
            });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await expect(interactor.getBlockNumber()).rejects.toThrow(GetBlockNumberError);
            await expect(interactor.getBlockNumber()).rejects.toThrow(
                "Get block number failed: RPC timeout",
            );
        });

        it("handle block number 0", async () => {
            const client = createMockClient({ getBlockNumber: async () => 0n });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            const result = await interactor.getBlockNumber();

            expect(result).toBe("0x0");
        });
    });

    describe("waitForTransactionReceipt", () => {
        it("return TxReceipt for successful tx", async () => {
            const client = createMockClient({
                waitForTransactionReceipt: async () => ({
                    status: "success",
                    blockNumber: 100n,
                    logs: [],
                }),
            });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            const result = await interactor.waitForTransactionReceipt(VALID_TX_HASH);

            expect(result.status).toBe(true);
            expect(result.blockNumber).toBe("0x64");
            expect(result.logs).toEqual([]);
        });

        it("return status false for reverted tx", async () => {
            const client = createMockClient({
                waitForTransactionReceipt: async () => ({
                    status: "reverted",
                    blockNumber: 200n,
                    logs: [],
                }),
            });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            const result = await interactor.waitForTransactionReceipt(VALID_TX_HASH);

            expect(result.status).toBe(false);
            expect(result.blockNumber).toBe("0xc8");
        });

        it("map logs correctly", async () => {
            const client = createMockClient({
                waitForTransactionReceipt: async () => ({
                    status: "success",
                    blockNumber: 300n,
                    logs: [
                        {
                            address: "0x1234567890abcdef1234567890abcdef12345678",
                            topics: [
                                "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                            ],
                            data: "0x00000000000000000000000000000000000000000000000000000000000003e8",
                            blockNumber: 300n,
                            transactionHash: VALID_TX_HASH,
                            logIndex: 0,
                        },
                    ],
                }),
            });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            const result = await interactor.waitForTransactionReceipt(VALID_TX_HASH);

            expect(result.logs).toHaveLength(1);
            const log = result.logs[0]!;
            expect(log.address).toBe("0x1234567890abcdef1234567890abcdef12345678");
            expect(log.blockNumber).toBe("0x12c");
            expect(log.transactionHash).toBe(VALID_TX_HASH);
            expect(log.logIndex).toBe(0);
        });

        it("throw WaitForReceiptError on RPC failure", async () => {
            const client = createMockClient({
                waitForTransactionReceipt: async () => {
                    throw new Error("Transaction not found");
                },
            });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await expect(interactor.waitForTransactionReceipt(VALID_TX_HASH)).rejects.toThrow(
                WaitForReceiptError,
            );
            await expect(interactor.waitForTransactionReceipt(VALID_TX_HASH)).rejects.toThrow(
                "Wait for receipt failed: Transaction not found",
            );
        });

        it("pass hash to publicClient", async () => {
            const client = createMockClient();
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await interactor.waitForTransactionReceipt(VALID_TX_HASH);

            expect(client.waitForTransactionReceipt).toHaveBeenCalledWith({
                hash: VALID_TX_HASH,
            });
        });
    });

    describe("getLogs", () => {
        const TEST_EVENTS = [
            {
                type: "event" as const,
                name: "LeafInserted",
                inputs: [
                    { name: "_newLeaf", type: "uint256", indexed: false },
                    { name: "_root", type: "uint256", indexed: false },
                    { name: "_leafIndex", type: "uint256", indexed: false },
                ],
            },
        ] as const;

        it("delegate to publicClient.getLogs and return decoded logs", async () => {
            const mockLogs = [
                {
                    eventName: "LeafInserted",
                    args: { _newLeaf: 1n, _root: 2n, _leafIndex: 0n },
                    blockNumber: 42n,
                    transactionHash: "0xabc",
                },
            ];
            const client = createMockClient({ getLogs: async () => mockLogs });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            const result = await interactor.getLogs({
                address: TEST_ADDRESS,
                events: TEST_EVENTS,
            });

            expect(result).toHaveLength(1);
            expect(result[0].eventName).toBe("LeafInserted");
            expect(result[0].args["_newLeaf"]).toBe(1n);
            expect(result[0].blockNumber).toBe("0x2a");
            expect(result[0].transactionHash).toBe("0xabc");
            expect(client.getLogs).toHaveBeenCalledOnce();
        });

        it("reject invalid address", async () => {
            const client = createMockClient();
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await expect(
                interactor.getLogs({
                    address: "bad" as Address,
                    events: TEST_EVENTS,
                }),
            ).rejects.toThrow(InvalidContractAddress);
        });

        it("wrap RPC errors in EventReadError", async () => {
            const client = createMockClient({
                getLogs: async () => {
                    throw new Error("query limit exceeded");
                },
            });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await expect(
                interactor.getLogs({
                    address: TEST_ADDRESS,
                    events: TEST_EVENTS,
                }),
            ).rejects.toThrow(EventReadError);
        });

        it("preserve original error message in EventReadError", async () => {
            const client = createMockClient({
                getLogs: async () => {
                    throw new Error("query limit exceeded");
                },
            });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await expect(
                interactor.getLogs({
                    address: TEST_ADDRESS,
                    events: TEST_EVENTS,
                }),
            ).rejects.toThrow("Event log fetch failed: query limit exceeded");
        });

        it("use default fromBlock 0n and toBlock latest", async () => {
            const client = createMockClient({ getLogs: async () => [] });
            const interactor = new ViemRPCInteractor({ publicClient: client });

            await interactor.getLogs({
                address: TEST_ADDRESS,
                events: TEST_EVENTS,
            });

            expect(client.getLogs).toHaveBeenCalledWith(
                expect.objectContaining({
                    fromBlock: 0n,
                    toBlock: "latest",
                }),
            );
        });
    });
});
