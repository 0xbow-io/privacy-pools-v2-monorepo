import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Address, FinalizedBlockResult, IRPCInteractor } from "../../../src/internal.js";
import {
    ContractCallError,
    createEvmEntrypointInteractor,
    EntrypointInteractor,
    InvalidAddressArgument,
    InvalidInteractorAddress,
} from "../../../src/internal.js";

const VALID_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VALID_TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const VALID_OWNER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const VALID_SPENDER = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;

function createMockRPC(readContractImpl?: IRPCInteractor["readContract"]): IRPCInteractor {
    return {
        readContract: vi.fn(readContractImpl ?? (async (): Promise<void> => undefined)),
        getLogs: vi.fn(async () => []),
        getLogsPaginated: vi.fn(async () => []),
        getBlockNumber: vi.fn(async () => "0x0"),
        getFinalizedBlockNumber: vi.fn(
            async () => ({ status: "unsupported" }) as FinalizedBlockResult,
        ),
        waitForTransactionReceipt: vi.fn(),
    };
}

describe("EntrypointInteractor", () => {
    let mockRPC: IRPCInteractor;
    let interactor: EntrypointInteractor;

    beforeEach(() => {
        mockRPC = createMockRPC();
        interactor = createEvmEntrypointInteractor({
            rpcInteractor: mockRPC,
            contractAddress: VALID_ADDRESS,
        });
    });

    describe("constructor", () => {
        it("create instance with valid config", () => {
            expect(interactor).toBeInstanceOf(EntrypointInteractor);
        });

        it("reject invalid contract address", () => {
            expect(
                () =>
                    createEvmEntrypointInteractor({
                        rpcInteractor: mockRPC,
                        contractAddress: "not-an-address" as Address,
                    }),
            ).toThrow(InvalidInteractorAddress);
        });

        it("reject short contract address", () => {
            expect(
                () =>
                    createEvmEntrypointInteractor({
                        rpcInteractor: mockRPC,
                        contractAddress: "0x1234" as Address,
                    }),
            ).toThrow(InvalidInteractorAddress);
        });
    });

    describe("getPoolVaultAddress", () => {
        it("return the pool vault address from the contract", async () => {
            const expectedAddress = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Address;
            mockRPC = createMockRPC(async () => expectedAddress);
            interactor = createEvmEntrypointInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getPoolVaultAddress();

            expect(result).toBe(expectedAddress);
            expect(mockRPC.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "poolVault" }),
            );
        });

        it("wrap RPC errors in ContractCallError", async () => {
            mockRPC = createMockRPC(async () => {
                throw new Error("connection refused");
            });
            interactor = createEvmEntrypointInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.getPoolVaultAddress()).rejects.toThrow(ContractCallError);
            await expect(interactor.getPoolVaultAddress()).rejects.toThrow("connection refused");
        });
    });

    describe("getASPRegistryAddress", () => {
        it("return the ASP registry address from the contract", async () => {
            const expectedAddress = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed" as Address;
            mockRPC = createMockRPC(async () => expectedAddress);
            interactor = createEvmEntrypointInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getASPRegistryAddress();

            expect(result).toBe(expectedAddress);
            expect(mockRPC.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "aspRegistry" }),
            );
        });

        it("wrap RPC errors in ContractCallError", async () => {
            mockRPC = createMockRPC(async () => {
                throw new Error("timeout");
            });
            interactor = createEvmEntrypointInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.getASPRegistryAddress()).rejects.toThrow(ContractCallError);
        });
    });

    describe("getAssetConfig", () => {
        it("return the asset configuration", async () => {
            const mockConfig = {
                enabled: true,
                vettingFeeBPS: 50n,
                minAmount: 1000n,
                maxRelayFee: 100n,
            };
            mockRPC = createMockRPC(async () => mockConfig);
            interactor = createEvmEntrypointInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getAssetConfig(VALID_TOKEN);

            expect(result).toEqual({
                enabled: true,
                vettingFeeBPS: "0x0000000000000000000000000000000000000000000000000000000000000032",
                minAmount: "0x00000000000000000000000000000000000000000000000000000000000003e8",
                maxRelayFee: "0x0000000000000000000000000000000000000000000000000000000000000064",
            });
            expect(mockRPC.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "assets",
                    args: [VALID_TOKEN],
                }),
            );
        });

        it("reject invalid asset address", async () => {
            await expect(interactor.getAssetConfig("bad" as Address)).rejects.toThrow(
                InvalidAddressArgument,
            );
        });

        it("wrap RPC errors in ContractCallError", async () => {
            mockRPC = createMockRPC(async () => {
                throw new Error("reverted");
            });
            interactor = createEvmEntrypointInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(interactor.getAssetConfig(VALID_TOKEN)).rejects.toThrow(ContractCallError);
        });
    });

    describe("getAllowance", () => {
        it("return the ERC20 allowance", async () => {
            mockRPC = createMockRPC(async () => 5000n);
            interactor = createEvmEntrypointInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            const result = await interactor.getAllowance(VALID_TOKEN, VALID_OWNER, VALID_SPENDER);

            expect(result).toBe(
                "0x0000000000000000000000000000000000000000000000000000000000001388",
            );
            expect(mockRPC.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: VALID_TOKEN,
                    functionName: "allowance",
                    args: [VALID_OWNER, VALID_SPENDER],
                }),
            );
        });

        it("reject invalid token address", async () => {
            await expect(
                interactor.getAllowance("bad" as Address, VALID_OWNER, VALID_SPENDER),
            ).rejects.toThrow(InvalidAddressArgument);
        });

        it("reject invalid owner address", async () => {
            await expect(
                interactor.getAllowance(VALID_TOKEN, "bad" as Address, VALID_SPENDER),
            ).rejects.toThrow(InvalidAddressArgument);
        });

        it("reject invalid spender address", async () => {
            await expect(
                interactor.getAllowance(VALID_TOKEN, VALID_OWNER, "bad" as Address),
            ).rejects.toThrow(InvalidAddressArgument);
        });

        it("wrap RPC errors in ContractCallError", async () => {
            mockRPC = createMockRPC(async () => {
                throw new Error("execution reverted");
            });
            interactor = createEvmEntrypointInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });

            await expect(
                interactor.getAllowance(VALID_TOKEN, VALID_OWNER, VALID_SPENDER),
            ).rejects.toThrow(ContractCallError);
        });
    });
});
