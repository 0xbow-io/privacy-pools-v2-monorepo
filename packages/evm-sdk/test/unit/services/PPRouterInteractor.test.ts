import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Address, IRPCInteractor } from "../../../src/internal.js";
import {
    ContractCallError,
    InvalidContractResult,
    InvalidInteractorAddress,
    PPRouterInteractor,
} from "../../../src/internal.js";

const VALID_ADDRESS = "0x08e984a00E5575b366310f3dE7f53135e139F1b1" as Address;

function createMockRPC(readContractImpl?: IRPCInteractor["readContract"]): IRPCInteractor {
    return {
        readContract: vi.fn(readContractImpl ?? (async (): Promise<bigint> => 0n)),
        getLogs: vi.fn(async () => []),
        getLogsPaginated: vi.fn(async () => []),
        getBlockNumber: vi.fn(async () => "0x0"),
        waitForTransactionReceipt: vi.fn(),
    } as unknown as IRPCInteractor;
}

function makeInteractor(impl?: IRPCInteractor["readContract"]): PPRouterInteractor {
    return new PPRouterInteractor({
        rpcInteractor: createMockRPC(impl),
        contractAddress: VALID_ADDRESS,
    });
}

describe("PPRouterInteractor", () => {
    let interactor: PPRouterInteractor;

    beforeEach(() => {
        interactor = makeInteractor();
    });

    describe("constructor", () => {
        it("creates an instance with valid config", () => {
            expect(interactor).toBeInstanceOf(PPRouterInteractor);
            expect(interactor.getAddress()).toBe(VALID_ADDRESS);
        });

        it("rejects an invalid contract address", () => {
            expect(
                () =>
                    new PPRouterInteractor({
                        rpcInteractor: createMockRPC(),
                        contractAddress: "not-hex" as Address,
                    }),
            ).toThrow(InvalidInteractorAddress);
        });
    });

    describe("quote", () => {
        it("returns { underlyingNeeded, total } from the tuple result", async () => {
            interactor = makeInteractor(async () => [1_000_000n, 1_005_000n] as unknown as bigint);
            await expect(interactor.quote(1_000_000_000_000_000_000n)).resolves.toEqual({
                underlyingNeeded: 1_000_000n,
                total: 1_005_000n,
            });
        });

        it("throws InvalidContractResult when the result is not a 2-tuple", async () => {
            interactor = makeInteractor(async () => 123n);
            await expect(interactor.quote(1n)).rejects.toBeInstanceOf(InvalidContractResult);
        });

        it("reads the first two elements of a longer tuple", async () => {
            interactor = makeInteractor(async () => [10n, 20n, 30n] as unknown as bigint);
            await expect(interactor.quote(1n)).resolves.toEqual({
                underlyingNeeded: 10n,
                total: 20n,
            });
        });

        it("throws InvalidContractResult when the first tuple element is not a bigint", async () => {
            interactor = makeInteractor(async () => ["x", 2n] as unknown as bigint);
            await expect(interactor.quote(1n)).rejects.toBeInstanceOf(InvalidContractResult);
        });

        it("throws InvalidContractResult when the second tuple element is not a bigint", async () => {
            interactor = makeInteractor(async () => [1n, "x"] as unknown as bigint);
            await expect(interactor.quote(1n)).rejects.toBeInstanceOf(InvalidContractResult);
        });

        it("wraps an RPC failure in ContractCallError", async () => {
            interactor = makeInteractor(async () => {
                throw new Error("rpc down");
            });
            await expect(interactor.quote(1n)).rejects.toBeInstanceOf(ContractCallError);
        });
    });

    describe("quoteWithdraw", () => {
        it("returns the underlying out", async () => {
            const spy = vi.fn(async () => 1_020_000n);
            interactor = makeInteractor(spy);
            await expect(interactor.quoteWithdraw(1_000_000_000_000_000_000n)).resolves.toBe(
                1_020_000n,
            );
            expect(spy).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "quoteWithdraw",
                    args: [1_000_000_000_000_000_000n],
                }),
            );
        });

        it("throws InvalidContractResult on a non-bigint result", async () => {
            interactor = makeInteractor(async () => ({}) as unknown as bigint);
            await expect(interactor.quoteWithdraw(1n)).rejects.toBeInstanceOf(
                InvalidContractResult,
            );
        });

        it("wraps an RPC failure in ContractCallError", async () => {
            interactor = makeInteractor(async () => {
                throw new Error("rpc down");
            });
            await expect(interactor.quoteWithdraw(1n)).rejects.toBeInstanceOf(ContractCallError);
        });
    });
});
