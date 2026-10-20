import { decodeFunctionData } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Address, FinalizedBlockResult, IRPCInteractor } from "../../../src/internal.js";
import {
    InvalidInteractorAddress,
    InvalidYieldAddress,
    PP_YIELD_TOKEN_ZAP_REDEEM_ABI,
    PPYieldTokenZapInteractor,
} from "../../../src/internal.js";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const VALID_ZAP = "0x305E689dc6659273CAD6F5b43Ae4001f39D2519d" as Address;
const RECEIVER = "0x1234567890abcdef1234567890abcdef12345678" as Address;

function createMockRPC(): IRPCInteractor {
    return {
        readContract: vi.fn(async (): Promise<bigint> => 0n),
        getLogs: vi.fn(),
        getLogsPaginated: vi.fn(),
        getBlockNumber: vi.fn(async () => "0x0"),
        getFinalizedBlockNumber: vi.fn(
            async () => ({ status: "unsupported" }) as FinalizedBlockResult,
        ),
        waitForTransactionReceipt: vi.fn(),
    };
}

// Y-1: the loose-ppShare -> underlying exit (esp. after ragequit) is now SDK-reachable.
describe("PPYieldTokenZapInteractor", () => {
    let interactor: PPYieldTokenZapInteractor;

    beforeEach(() => {
        interactor = new PPYieldTokenZapInteractor({
            rpcInteractor: createMockRPC(),
            contractAddress: VALID_ZAP,
        });
    });

    it("expose the zap address", () => {
        expect(interactor.getAddress()).toBe(VALID_ZAP);
    });

    it("reject an invalid contract address", () => {
        expect(
            () =>
                new PPYieldTokenZapInteractor({
                    rpcInteractor: createMockRPC(),
                    contractAddress: "bad" as Address,
                }),
        ).toThrow(InvalidInteractorAddress);
    });

    it("encode redeemToUnderlying calldata targeting the zap", () => {
        const shares = 1_000_000_000_000_000_000n;
        const tx = interactor.encodeRedeemToUnderlying(shares, RECEIVER);

        expect(tx.to).toBe(VALID_ZAP);
        expect(tx.value).toBe("0x0");
        const decoded = decodeFunctionData({
            abi: PP_YIELD_TOKEN_ZAP_REDEEM_ABI,
            data: tx.data as `0x${string}`,
        });
        expect(decoded.functionName).toBe("redeemToUnderlying");
        expect(decoded.args[0]).toBe(shares);
        expect((decoded.args[1] as string).toLowerCase()).toBe(RECEIVER.toLowerCase());
    });

    it("reject a zero receiver (would burn the redeemed underlying)", () => {
        expect(() => interactor.encodeRedeemToUnderlying(1n, ZERO)).toThrow(InvalidYieldAddress);
    });
});
