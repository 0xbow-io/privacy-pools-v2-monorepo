import { decodeFunctionData } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Address, IRPCInteractor } from "../../../src/internal.js";
import {
    ContractCallError,
    InvalidContractResult,
    InvalidInteractorAddress,
    InvalidYieldAddress,
    PP_YIELD_TOKEN_REDEEM_ABI,
    PPYieldTokenInteractor,
} from "../../../src/internal.js";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const VALID_ADDRESS = "0x305E689dc6659273CAD6F5b43Ae4001f39D2519d" as Address;

function createMockRPC(readContractImpl?: IRPCInteractor["readContract"]): IRPCInteractor {
    return {
        readContract: vi.fn(readContractImpl ?? (async (): Promise<bigint> => 0n)),
        getLogs: vi.fn(async () => []),
        getLogsPaginated: vi.fn(async () => []),
        getBlockNumber: vi.fn(async () => "0x0"),
        waitForTransactionReceipt: vi.fn(),
    } as unknown as IRPCInteractor;
}

describe("PPYieldTokenInteractor", () => {
    let mockRPC: IRPCInteractor;
    let interactor: PPYieldTokenInteractor;

    beforeEach(() => {
        mockRPC = createMockRPC();
        interactor = new PPYieldTokenInteractor({
            rpcInteractor: mockRPC,
            contractAddress: VALID_ADDRESS,
        });
    });

    describe("constructor", () => {
        it("creates an instance with valid config", () => {
            expect(interactor).toBeInstanceOf(PPYieldTokenInteractor);
            expect(interactor.getAddress()).toBe(VALID_ADDRESS);
        });

        it("rejects an invalid contract address", () => {
            expect(
                () =>
                    new PPYieldTokenInteractor({
                        rpcInteractor: mockRPC,
                        contractAddress: "not-hex" as Address,
                    }),
            ).toThrow(InvalidInteractorAddress);
        });
    });

    describe("exchangeRate", () => {
        it("returns the live exchange rate", async () => {
            mockRPC = createMockRPC(async () => 1_020_000n);
            interactor = new PPYieldTokenInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });
            await expect(interactor.exchangeRate()).resolves.toBe(1_020_000n);
        });

        it("throws InvalidContractResult on a non-bigint result", async () => {
            mockRPC = createMockRPC(async () => "nope" as unknown as bigint);
            interactor = new PPYieldTokenInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });
            await expect(interactor.exchangeRate()).rejects.toBeInstanceOf(InvalidContractResult);
        });

        it("wraps an RPC failure in ContractCallError", async () => {
            mockRPC = createMockRPC(async () => {
                throw new Error("rpc down");
            });
            interactor = new PPYieldTokenInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });
            await expect(interactor.exchangeRate()).rejects.toBeInstanceOf(ContractCallError);
        });
    });

    describe("previewDeposit", () => {
        it("forwards the assets arg and returns shares", async () => {
            const spy = vi.fn(async () => 980_000_000_000_000_000n);
            mockRPC = createMockRPC(spy);
            interactor = new PPYieldTokenInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });
            await expect(interactor.previewDeposit(1_000_000n)).resolves.toBe(
                980_000_000_000_000_000n,
            );
            expect(spy).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "previewDeposit", args: [1_000_000n] }),
            );
        });
    });

    describe("encodeRedeem", () => {
        it("encodes redeem(shares, receiver, owner) targeting the ppUSDC contract", () => {
            const receiver = "0x000000000000000000000000000000000000beef" as Address;
            const owner = "0x000000000000000000000000000000000000cafe" as Address;
            const tx = interactor.encodeRedeem(1_000_000_000_000_000_000n, receiver, owner);

            expect(tx.to).toBe(VALID_ADDRESS);
            expect(tx.value).toBe("0x0");
            const decoded = decodeFunctionData({ abi: PP_YIELD_TOKEN_REDEEM_ABI, data: tx.data });
            expect(decoded.functionName).toBe("redeem");
            const [shares, decReceiver, decOwner] = decoded.args;
            expect(shares).toBe(1_000_000_000_000_000_000n);
            expect((decReceiver as string).toLowerCase()).toBe(receiver.toLowerCase());
            expect((decOwner as string).toLowerCase()).toBe(owner.toLowerCase());
        });

        it("rejects a zero receiver (would burn the redeemed aToken)", () => {
            const owner = "0x000000000000000000000000000000000000cafe" as Address;
            expect(() => interactor.encodeRedeem(1n, ZERO, owner)).toThrow(InvalidYieldAddress);
        });

        it("rejects a zero owner", () => {
            const receiver = "0x000000000000000000000000000000000000beef" as Address;
            expect(() => interactor.encodeRedeem(1n, receiver, ZERO)).toThrow(InvalidYieldAddress);
        });
    });

    describe("previewRedeem", () => {
        it("forwards the shares arg and returns underlying", async () => {
            const spy = vi.fn(async () => 1_020_000n);
            mockRPC = createMockRPC(spy);
            interactor = new PPYieldTokenInteractor({
                rpcInteractor: mockRPC,
                contractAddress: VALID_ADDRESS,
            });
            await expect(interactor.previewRedeem(1_000_000_000_000_000_000n)).resolves.toBe(
                1_020_000n,
            );
            expect(spy).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "previewRedeem",
                    args: [1_000_000_000_000_000_000n],
                }),
            );
        });
    });
});
