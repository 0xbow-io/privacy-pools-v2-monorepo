import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Address, FinalizedBlockResult, IRPCInteractor } from "../../../src/internal.js";
import {
    ASPRegistryInteractor,
    ContractCallError,
    InvalidInteractorAddress,
} from "../../../src/internal.js";

const VALID_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as Address;

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

describe("ASPRegistryInteractor", () => {
    let mockRPC: IRPCInteractor;
    let interactor: ASPRegistryInteractor;

    beforeEach(() => {
        mockRPC = createMockRPC();
        interactor = new ASPRegistryInteractor({
            rpcInteractor: mockRPC,
            contractAddress: VALID_ADDRESS,
        });
    });

    describe("constructor", () => {
        it("create instance with valid config", () => {
            expect(interactor).toBeInstanceOf(ASPRegistryInteractor);
        });

        it("reject invalid contract address", () => {
            expect(
                () =>
                    new ASPRegistryInteractor({
                        rpcInteractor: mockRPC,
                        contractAddress: "not-valid" as Address,
                    }),
            ).toThrow(InvalidInteractorAddress);
        });

        it("reject short contract address", () => {
            expect(
                () =>
                    new ASPRegistryInteractor({
                        rpcInteractor: mockRPC,
                        contractAddress: "0xabcd" as Address,
                    }),
            ).toThrow(InvalidInteractorAddress);
        });
    });

    describe("getLatestASPRoot", () => {
        it("return zero-padded hex hash", async () => {
            mockRPC = createMockRPC(async () => 0xabcdefn);
            interactor = new ASPRegistryInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getLatestASPRoot();

            expect(result).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000abcdef",
            );
            expect(mockRPC.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "latestASPRoot" }),
            );
        });

        it("return zero hash when ASP set is empty and contract returns 0", async () => {
            mockRPC = createMockRPC(async () => 0n);
            interactor = new ASPRegistryInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getLatestASPRoot();

            expect(result).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            );
        });

        it("handle large uint256 values", async () => {
            const largeValue = 2n ** 255n;
            mockRPC = createMockRPC(async () => largeValue);
            interactor = new ASPRegistryInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getLatestASPRoot();

            expect(result).toMatch(/^0x[0-9a-f]{64}$/);
            expect(BigInt(result)).toBe(largeValue);
        });

        it("wrap RPC errors in ContractCallError", async () => {
            mockRPC = createMockRPC(async () => {
                throw new Error("ASP set is empty");
            });
            interactor = new ASPRegistryInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.getLatestASPRoot()).rejects.toThrow(ContractCallError);
            await expect(interactor.getLatestASPRoot()).rejects.toThrow("ASP set is empty");
        });

        it("wrap non-Error values in ContractCallError", async () => {
            mockRPC = createMockRPC(async () => {
                throw "raw string error";
            });
            interactor = new ASPRegistryInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.getLatestASPRoot()).rejects.toThrow(
                "Contract call failed: raw string error",
            );
        });
    });

    describe("getLatestAssociationSetData", () => {
        /** Helper to encode a UTF-8 string as 0x-prefixed hex bytes. */
        function encodeBytes(str: string): string {
            const bytes = new TextEncoder().encode(str);
            return (
                "0x" +
                Array.from(bytes)
                    .map((b) => b.toString(16).padStart(2, "0"))
                    .join("")
            );
        }

        it("return root and decoded IPFS CID", async () => {
            const cidHex = encodeBytes("QmTestCid123");
            mockRPC = createMockRPC(async (args: unknown) => {
                const callArgs = args as { functionName: string };
                if (callArgs.functionName === "latestASPRoot") return 0xabcdefn;
                if (callArgs.functionName === "latestIPFSCID") return cidHex;
                return 0n;
            });
            interactor = new ASPRegistryInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getLatestAssociationSetData();
            expect(result.ipfsCID).toBe("QmTestCid123");
            expect(result.root).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000abcdef",
            );
        });

        it("wrap RPC failure in ContractCallError", async () => {
            mockRPC = createMockRPC(async (args: unknown) => {
                const callArgs = args as { functionName: string };
                if (callArgs.functionName === "latestASPRoot") return 0xabcdefn;
                if (callArgs.functionName === "latestIPFSCID")
                    throw new Error("execution reverted");
                return 0n;
            });
            interactor = new ASPRegistryInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.getLatestAssociationSetData()).rejects.toThrow(
                ContractCallError,
            );
        });
    });
});
