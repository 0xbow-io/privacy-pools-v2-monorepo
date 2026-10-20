import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    DecodedEventLog,
    Eip712TypedData,
    FinalizedBlockResult,
    Hash,
    Hex,
    IRPCInteractor,
    IWalletInteractor,
} from "../../../src/internal.js";
import {
    buildSetAuthPolicyTypedData,
    ContractCallError,
    InvalidAddressArgument,
    InvalidContractResult,
    InvalidHashArgument,
    InvalidInteractorAddress,
    createEvmKeystoreInteractor,
    KeystoreInteractor,
    WalletNotAvailable,
} from "../../../src/internal.js";

const VALID_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VALID_ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const VALID_HASH = "0x00000000000000000000000000000000000000000000000000000000deadbeef" as Hash;

function createMockRPC(overrides?: {
    readContract?: IRPCInteractor["readContract"];
    getLogs?: () => Promise<unknown[]>;
}): IRPCInteractor {
    const getLogs = (overrides?.getLogs ??
        (async (): Promise<DecodedEventLog[]> => [])) as IRPCInteractor["getLogs"];
    return {
        readContract: vi.fn(overrides?.readContract ?? (async (): Promise<bigint> => 0n)),
        getLogs: vi.fn(getLogs),
        getLogsPaginated: vi.fn(getLogs) as IRPCInteractor["getLogsPaginated"],
        getBlockNumber: vi.fn(async () => "0x0"),
        getFinalizedBlockNumber: vi.fn(
            async () => ({ status: "unsupported" }) as FinalizedBlockResult,
        ),
        waitForTransactionReceipt: vi.fn(),
    };
}

describe("KeystoreInteractor", () => {
    let mockRPC: IRPCInteractor;
    let interactor: KeystoreInteractor;

    beforeEach(() => {
        mockRPC = createMockRPC();
        interactor = createEvmKeystoreInteractor({
            rpcInteractor: mockRPC,
            contractAddress: VALID_ADDRESS,
        });
    });

    describe("constructor", () => {
        it("create instance with valid config", () => {
            expect(interactor).toBeInstanceOf(KeystoreInteractor);
        });

        it("reject invalid contract address", () => {
            expect(
                () =>
                    createEvmKeystoreInteractor({
                        rpcInteractor: mockRPC,
                        contractAddress: "bad" as Address,
                    }),
            ).toThrow(InvalidInteractorAddress);
        });
    });

    describe("getNullifyingKeyHash", () => {
        it("return zero-padded hex hash for a registered account", async () => {
            mockRPC = createMockRPC({ readContract: async () => 0xdeadbeefn });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getNullifyingKeyHash(VALID_ACCOUNT);

            expect(result).toBe(
                "0x00000000000000000000000000000000000000000000000000000000deadbeef",
            );
            expect(mockRPC.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "nullifyingKeys",
                    args: [VALID_ACCOUNT],
                }),
            );
        });

        it("return zero hash for unregistered account", async () => {
            mockRPC = createMockRPC({ readContract: async () => 0n });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getNullifyingKeyHash(VALID_ACCOUNT);

            expect(result).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            );
        });

        it("reject invalid account address", async () => {
            await expect(interactor.getNullifyingKeyHash("not-address" as Address)).rejects.toThrow(
                InvalidAddressArgument,
            );
        });

        it("wrap RPC errors in ContractCallError", async () => {
            mockRPC = createMockRPC({
                readContract: async () => {
                    throw new Error("reverted");
                },
            });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.getNullifyingKeyHash(VALID_ACCOUNT)).rejects.toThrow(
                ContractCallError,
            );
        });
    });

    describe("getViewingKey", () => {
        it("return the viewing key bytes32", async () => {
            const viewingKey =
                "0xabcdef0000000000000000000000000000000000000000000000000000000001" as Hash;
            mockRPC = createMockRPC({ readContract: async () => viewingKey });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getViewingKey(VALID_ACCOUNT);

            expect(result).toBe(viewingKey);
            expect(mockRPC.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "viewingKeys",
                    args: [VALID_ACCOUNT],
                }),
            );
        });

        it("reject invalid account address", async () => {
            await expect(interactor.getViewingKey("0x" as Address)).rejects.toThrow(
                InvalidAddressArgument,
            );
        });

        it("wrap RPC errors in ContractCallError", async () => {
            mockRPC = createMockRPC({
                readContract: async () => {
                    throw new Error("timeout");
                },
            });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.getViewingKey(VALID_ACCOUNT)).rejects.toThrow(
                ContractCallError,
            );
        });
    });

    describe("isKnownRoot", () => {
        it("return true for a known root", async () => {
            mockRPC = createMockRPC({ readContract: async () => true });
            interactor = createEvmKeystoreInteractor({
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
            mockRPC = createMockRPC({ readContract: async () => false });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.isKnownRoot(VALID_HASH);

            expect(result).toBe(false);
        });

        it("reject invalid hex hash", async () => {
            await expect(interactor.isKnownRoot("bad" as Hash)).rejects.toThrow(
                InvalidHashArgument,
            );
        });

        it("wrap RPC errors in ContractCallError", async () => {
            mockRPC = createMockRPC({
                readContract: async () => {
                    throw new Error("reverted");
                },
            });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.isKnownRoot(VALID_HASH)).rejects.toThrow(ContractCallError);
        });
    });

    describe("getKeystoreLeaves", () => {
        it("return leaves from LeafInserted events in order", async () => {
            mockRPC = createMockRPC({
                getLogs: async () => [
                    {
                        eventName: "LeafInserted",
                        args: { _newLeaf: 0xaaan, _root: 0n, _leafIndex: 0n },
                    },
                    {
                        eventName: "LeafInserted",
                        args: { _newLeaf: 0xbbbn, _root: 0n, _leafIndex: 1n },
                    },
                    {
                        eventName: "LeafInserted",
                        args: { _newLeaf: 0xcccn, _root: 0n, _leafIndex: 2n },
                    },
                ],
            });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const leaves = await interactor.getKeystoreLeaves();

            expect(leaves).toHaveLength(3);
            expect(leaves[0]).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000000aaa",
            );
            expect(leaves[1]).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000000bbb",
            );
            expect(leaves[2]).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000000ccc",
            );
        });

        it("handle LeafUpdated by overwriting the leaf at the given index", async () => {
            mockRPC = createMockRPC({
                getLogs: async () => [
                    {
                        eventName: "LeafInserted",
                        args: { _newLeaf: 0xaaan, _root: 0n, _leafIndex: 0n },
                    },
                    {
                        eventName: "LeafInserted",
                        args: { _newLeaf: 0xbbbn, _root: 0n, _leafIndex: 1n },
                    },
                    {
                        eventName: "LeafUpdated",
                        args: { _newLeaf: 0xdddn, _root: 0n, _leafIndex: 0n },
                    },
                ],
            });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const leaves = await interactor.getKeystoreLeaves();

            expect(leaves).toHaveLength(2);
            expect(leaves[0]).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000000ddd",
            );
            expect(leaves[1]).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000000bbb",
            );
        });

        it("return empty array when no events exist", async () => {
            mockRPC = createMockRPC({ getLogs: async () => [] });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const leaves = await interactor.getKeystoreLeaves();

            expect(leaves).toEqual([]);
        });

        it("wrap RPC errors in ContractCallError", async () => {
            mockRPC = createMockRPC({
                getLogs: async () => {
                    throw new Error("query timeout");
                },
            });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.getKeystoreLeaves()).rejects.toThrow(ContractCallError);
        });

        it("reject leaf index exceeding MAX_SAFE_INTEGER with InvalidContractResult", async () => {
            mockRPC = createMockRPC({
                getLogs: async () => [
                    {
                        eventName: "LeafInserted",
                        args: {
                            _newLeaf: 0xaaan,
                            _root: 0n,
                            _leafIndex: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
                        },
                    },
                ],
            });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.getKeystoreLeaves()).rejects.toThrow(InvalidContractResult);
        });

        it("reject negative leaf value with InvalidContractResult", async () => {
            mockRPC = createMockRPC({
                getLogs: async () => [
                    {
                        eventName: "LeafInserted",
                        args: { _newLeaf: -1n, _root: 0n, _leafIndex: 0n },
                    },
                ],
            });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.getKeystoreLeaves()).rejects.toThrow(InvalidContractResult);
        });
    });

    describe("leaf cache seeding", () => {
        it("exportLeafCache returns undefined before any fetch", () => {
            expect(interactor.exportLeafCache()).toBeUndefined();
        });

        it("exportLeafCache returns the current cache after a fetch", async () => {
            mockRPC = createMockRPC({
                getLogs: async () => [
                    {
                        eventName: "LeafInserted",
                        args: { _newLeaf: 0xaaan, _root: 0n, _leafIndex: 0n },
                    },
                ],
            });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await interactor.getKeystoreLeaves();
            const seed = interactor.exportLeafCache();

            expect(seed).toBeDefined();
            expect(seed?.toBlock).toBe(0n);
            expect(seed?.leaves).toEqual([
                "0x0000000000000000000000000000000000000000000000000000000000000aaa",
            ]);
        });

        it("a seed pre-populates the cache and getKeystoreLeaves skips scanning already-covered blocks", async () => {
            const getLogs = vi.fn(async () => []);
            mockRPC = createMockRPC({ getLogs });
            mockRPC.getBlockNumber = vi.fn(async () => "0x5");

            const seededLeaves: Hash[] = [
                "0x0000000000000000000000000000000000000000000000000000000000000aaa",
            ];
            interactor = createEvmKeystoreInteractor(
                { rpcInteractor: mockRPC, contractAddress: VALID_ADDRESS },
                { seed: { toBlock: 5n, leaves: seededLeaves } },
            );

            const leaves = await interactor.getKeystoreLeaves();

            expect(leaves).toEqual(seededLeaves);
            expect(getLogs).not.toHaveBeenCalled();
        });

        it("a seed makes getKeystoreLeaves a delta-fetch from seed.toBlock + 1", async () => {
            const getLogs = vi.fn(async () => [
                {
                    eventName: "LeafInserted",
                    args: { _newLeaf: 0xbbbn, _root: 0n, _leafIndex: 1n },
                },
            ]);
            mockRPC = createMockRPC({ getLogs });
            mockRPC.getBlockNumber = vi.fn(async () => "0xa");

            const seededLeaves: Hash[] = [
                "0x0000000000000000000000000000000000000000000000000000000000000aaa",
            ];
            interactor = createEvmKeystoreInteractor(
                { rpcInteractor: mockRPC, contractAddress: VALID_ADDRESS },
                { seed: { toBlock: 5n, leaves: seededLeaves } },
            );

            const leaves = await interactor.getKeystoreLeaves();

            expect(getLogs).toHaveBeenCalledWith(
                expect.objectContaining({ fromBlock: 6n, toBlock: 10n }),
            );
            expect(leaves).toEqual([
                "0x0000000000000000000000000000000000000000000000000000000000000aaa",
                "0x0000000000000000000000000000000000000000000000000000000000000bbb",
            ]);
        });
    });

    describe("getCurrentAuthorizerDigest", () => {
        const OWNER = "0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA" as Address;
        const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;

        it("return the latest authDigest after multiple AuthPolicyUpdated events for the same account", async () => {
            mockRPC = createMockRPC({
                getLogs: async () => [
                    {
                        eventName: "AuthPolicySet",
                        args: { _account: OWNER, _authDigest: 0xa1n },
                    },
                    {
                        eventName: "AuthPolicyUpdated",
                        args: { _account: OWNER, _authDigest: 0xb2n },
                    },
                    {
                        eventName: "AuthPolicyUpdated",
                        args: { _account: OWNER, _authDigest: 0xc3n },
                    },
                ],
            });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const digest = await interactor.getCurrentAuthorizerDigest(OWNER);

            expect(digest).toBe(
                "0x00000000000000000000000000000000000000000000000000000000000000c3",
            );
        });

        it("prefer AuthPolicyUpdated over earlier AuthPolicySet for the same account", async () => {
            mockRPC = createMockRPC({
                getLogs: async () => [
                    {
                        eventName: "AuthPolicySet",
                        args: { _account: OWNER, _authDigest: 0x111n },
                    },
                    {
                        eventName: "AuthPolicyUpdated",
                        args: { _account: OWNER, _authDigest: 0x222n },
                    },
                ],
            });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const digest = await interactor.getCurrentAuthorizerDigest(OWNER);

            expect(digest).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000000222",
            );
        });

        it("match the account case-insensitively when the on-chain event is checksum-cased", async () => {
            // Event emits the checksummed form; caller queries with all-lowercase.
            mockRPC = createMockRPC({
                getLogs: async () => [
                    {
                        eventName: "AuthPolicyUpdated",
                        args: { _account: OWNER, _authDigest: 0x999n },
                    },
                ],
            });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const digest = await interactor.getCurrentAuthorizerDigest(
                OWNER.toLowerCase() as Address,
            );

            expect(digest).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000000999",
            );
        });

        it("ignore events for other accounts and return null when the queried account has none", async () => {
            mockRPC = createMockRPC({
                getLogs: async () => [
                    {
                        eventName: "AuthPolicySet",
                        args: { _account: OTHER, _authDigest: 0x111n },
                    },
                    {
                        eventName: "AuthPolicyUpdated",
                        args: { _account: OTHER, _authDigest: 0x222n },
                    },
                ],
            });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const digest = await interactor.getCurrentAuthorizerDigest(OWNER);

            expect(digest).toBeNull();
        });

        it("return null when no auth events have been emitted", async () => {
            mockRPC = createMockRPC({ getLogs: async () => [] });
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const digest = await interactor.getCurrentAuthorizerDigest(OWNER);

            expect(digest).toBeNull();
        });

        it("throw InvalidAddressArgument for a malformed account address", async () => {
            mockRPC = createMockRPC();
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(
                interactor.getCurrentAuthorizerDigest("0xnotanaddress" as Address),
            ).rejects.toThrow(InvalidAddressArgument);
        });
    });

    describe("signTypedData", () => {
        const SIGNATURE = "0xdeadbeef" as Hex;

        function createMockWallet(): IWalletInteractor {
            return {
                sendTransaction: vi.fn(async () => "0x0" as Hex),
                signTypedData: vi.fn(async () => SIGNATURE),
                getAccounts: vi.fn(async () => [VALID_ACCOUNT]),
                getChainId: vi.fn(async () => 1),
            };
        }

        const typedData: Eip712TypedData = buildSetAuthPolicyTypedData({
            keystoreAddress: VALID_ADDRESS,
            chainId: 1,
            account: VALID_ACCOUNT,
            authDigest: VALID_HASH,
            nullifyingKeyHash: VALID_HASH,
            deadline: "0x1234" as Hex,
        });

        it("delegate to the attached wallet and return its signature", async () => {
            const wallet = createMockWallet();
            interactor = createEvmKeystoreInteractor(
                { rpcInteractor: mockRPC, contractAddress: VALID_ADDRESS },
                { walletInteractor: wallet },
            );

            const signature = await interactor.signTypedData(typedData);

            expect(signature).toBe(SIGNATURE);
            expect(wallet.signTypedData).toHaveBeenCalledWith(typedData);
        });

        it("throw WalletNotAvailable when no wallet is configured", async () => {
            interactor = createEvmKeystoreInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.signTypedData(typedData)).rejects.toThrow(WalletNotAvailable);
        });
    });
});
