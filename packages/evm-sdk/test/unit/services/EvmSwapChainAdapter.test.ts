import {
    ContractFunctionExecutionError,
    ContractFunctionRevertedError,
    ContractFunctionZeroDataError,
    decodeFunctionData,
    encodeFunctionData,
    ExecutionRevertedError,
    HttpRequestError,
    type BaseError,
} from "viem";
import { describe, expect, it } from "vitest";

import type { Address, Hex, IRPCInteractor, SwapThenCallParams } from "../../../src/internal.js";
import {
    ContractReadError,
    ERC20_APPROVE_ABI,
    EvmSwapChainAdapter,
    LIFI_EXECUTOR_SCREENING_ABI,
    LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
    NATIVE_ASSET_ADDRESS,
} from "../../../src/internal.js";

const SWAP = "0x1111111111111111111111111111111111111111" as Address;
const APPROVAL = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const ENTRYPOINT = "0x4444444444444444444444444444444444444444" as Address;
const RECEIVER = "0x5555555555555555555555555555555555555555" as Address;
const OUTPUT = "0x6666666666666666666666666666666666666666" as Address;
const LIFI_ZERO = "0x0000000000000000000000000000000000000000" as Address;

describe("EvmSwapChainAdapter.decodeSwapThenCall", () => {
    const adapter = new EvmSwapChainAdapter({ rpcInteractor: {} as IRPCInteractor });
    const params: SwapThenCallParams<Address> = {
        swapTarget: SWAP,
        swapApprovalAddress: APPROVAL,
        swapCallData: "0xabcdef" as Hex,
        inputToken: TOKEN,
        inputAmount: 123n,
        outputToken: NATIVE_ASSET_ADDRESS,
        callTarget: ENTRYPOINT,
        callData: "0xdeadbeef" as Hex,
        callValue: 101n,
        receiver: RECEIVER,
    };

    function modifyArgs(
        change: (
            args: ReturnType<typeof decodeFunctionData<typeof LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI>>["args"],
        ) => Parameters<typeof encodeFunctionData<typeof LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI>>[0]["args"],
    ): Hex {
        const { args } = decodeFunctionData({
            abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
            data: adapter.encodeSwapThenCall(params),
        });
        return encodeFunctionData({
            abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
            functionName: "swapAndExecute",
            args: change(args),
        });
    }

    it("round-trips the canonical executor call", () => {
        const decoded = adapter.decodeSwapThenCall(adapter.encodeSwapThenCall(params));
        expect(decoded).toEqual(params);
    });

    // DEV-489: the original two-step layout (ERC-20 in, native out) must not move by a byte, or
    // every native-coin deposit already proven on chain would decode as something else.
    it("keeps the ERC-20 in, native out layout exactly as before", () => {
        const { args } = decodeFunctionData({
            abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
            data: adapter.encodeSwapThenCall(params),
        });
        const [, swaps, transferred] = args;
        expect(transferred).toBe(TOKEN);
        expect(swaps[0].sendingAssetId).toBe(TOKEN);
        expect(swaps[0].receivingAssetId).toBe(LIFI_ZERO);
        expect(swaps[1].sendingAssetId).toBe(LIFI_ZERO);
        expect(swaps[1].receivingAssetId).toBe(LIFI_ZERO);
    });

    it("hands an ERC-20 output to the call and round-trips it", () => {
        const erc20Out: SwapThenCallParams<Address> = { ...params, outputToken: OUTPUT };
        const data = adapter.encodeSwapThenCall(erc20Out);
        const { args } = decodeFunctionData({ abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI, data });
        const [, swaps] = args;
        expect(swaps[0].receivingAssetId).toBe(OUTPUT);
        expect(swaps[1].sendingAssetId).toBe(OUTPUT);
        expect(swaps[1].fromAmount).toBe(101n);
        // The call's own output stays native, so leftover native coin goes back to the receiver
        // and leftover output token goes back through noLeftovers.
        expect(swaps[1].receivingAssetId).toBe(LIFI_ZERO);
        expect(adapter.decodeSwapThenCall(data)).toEqual(erc20Out);
    });

    it("spells a native input as address(0) and decodes it to the SDK's native address", () => {
        const nativeIn: SwapThenCallParams<Address> = {
            ...params,
            inputToken: NATIVE_ASSET_ADDRESS,
            outputToken: OUTPUT,
        };
        const data = adapter.encodeSwapThenCall(nativeIn);
        const { args } = decodeFunctionData({ abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI, data });
        const [, swaps, transferred] = args;
        expect(transferred).toBe(LIFI_ZERO);
        expect(swaps[0].sendingAssetId).toBe(LIFI_ZERO);
        expect(adapter.decodeSwapThenCall(data)).toEqual(nativeIn);
    });

    it("rejects native spelled 0xEeee inside the executor call", () => {
        expect(
            adapter.decodeSwapThenCall(
                modifyArgs(([id, swaps, , receiver, amount]) => [
                    id,
                    [{ ...swaps[0], sendingAssetId: NATIVE_ASSET_ADDRESS }, swaps[1]],
                    NATIVE_ASSET_ADDRESS,
                    receiver,
                    amount,
                ]),
            ),
        ).toBeUndefined();
    });

    it("rejects a call that spends a different token than the swap produced", () => {
        expect(
            adapter.decodeSwapThenCall(
                modifyArgs(([id, swaps, token, receiver, amount]) => [
                    id,
                    [{ ...swaps[0], receivingAssetId: OUTPUT }, swaps[1]],
                    token,
                    receiver,
                    amount,
                ]),
            ),
        ).toBeUndefined();
    });

    it("rejects swap 1 approveTo differing from callTo", () => {
        expect(
            adapter.decodeSwapThenCall(
                modifyArgs(([id, swaps, token, receiver, amount]) => [
                    id,
                    [swaps[0], { ...swaps[1], approveTo: APPROVAL }],
                    token,
                    receiver,
                    amount,
                ]),
            ),
        ).toBeUndefined();
    });

    it("rejects three swaps", () => {
        expect(
            adapter.decodeSwapThenCall(
                modifyArgs(([id, swaps, token, receiver, amount]) => [
                    id,
                    [swaps[0], swaps[1], swaps[1]],
                    token,
                    receiver,
                    amount,
                ]),
            ),
        ).toBeUndefined();
    });

    it("rejects a nonzero transactionId", () => {
        expect(
            adapter.decodeSwapThenCall(
                modifyArgs(([, swaps, token, receiver, amount]) => [
                    `0x${"01".repeat(32)}`,
                    swaps,
                    token,
                    receiver,
                    amount,
                ]),
            ),
        ).toBeUndefined();
    });

    it("rejects swap 0 fromAmount differing from _amount", () => {
        expect(
            adapter.decodeSwapThenCall(
                modifyArgs(([id, swaps, token, receiver, amount]) => [
                    id,
                    [{ ...swaps[0], fromAmount: amount + 1n }, swaps[1]],
                    token,
                    receiver,
                    amount,
                ]),
            ),
        ).toBeUndefined();
    });

    it("rejects non-executor calldata", () => {
        const approval = encodeFunctionData({
            abi: ERC20_APPROVE_ABI,
            functionName: "approve",
            args: [APPROVAL, 123n],
        });
        expect(adapter.decodeSwapThenCall(approval)).toBeUndefined();
    });
});

describe("EvmSwapChainAdapter executor screening", () => {
    const MAINNET_EXECUTOR = "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88" as Address;
    const PROXY = "0x68E1Acfa805dcA813116Ed6507E01c38D44318f0" as Address;

    function adapterAnswering(erc20Proxy: (address: Address) => unknown): EvmSwapChainAdapter {
        return new EvmSwapChainAdapter({
            rpcInteractor: {
                readContract: async ({ address }: { address: Address }) => erc20Proxy(address),
            } as unknown as IRPCInteractor,
        });
    }

    function wrappedReadError(address: Address, cause: BaseError): ContractReadError {
        return new ContractReadError(
            cause.message,
            new ContractFunctionExecutionError(cause, {
                abi: LIFI_EXECUTOR_SCREENING_ABI,
                functionName: "erc20Proxy",
                contractAddress: address,
            }),
        );
    }

    it("flags both Executor entry points whatever the target, and nothing else", () => {
        const adapter = adapterAnswering(() => undefined);
        const params: SwapThenCallParams<Address> = {
            swapTarget: SWAP,
            swapApprovalAddress: APPROVAL,
            swapCallData: "0xabcdef" as Hex,
            inputToken: TOKEN,
            inputAmount: 1n,
            outputToken: NATIVE_ASSET_ADDRESS,
            callTarget: ENTRYPOINT,
            callData: "0x" as Hex,
            callValue: 1n,
            receiver: RECEIVER,
        };
        expect(adapter.isSwapExecutorCall(adapter.encodeSwapThenCall(params))).toBe(true);
        // swapAndCompleteBridgeTokens(bytes32,(address,address,address,address,uint256,bytes,bool)[],address,address)
        expect(adapter.isSwapExecutorCall("0x4f91bc2b" as Hex)).toBe(true);
        expect(
            adapter.isSwapExecutorCall(
                encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [SWAP, 1n] }),
            ),
        ).toBe(false);
    });

    it("treats every configured Executor as one without an RPC read", async () => {
        const adapter = adapterAnswering(() => {
            throw new Error("must not be read");
        });
        expect(await adapter.isSwapExecutor(MAINNET_EXECUTOR)).toBe(true);
        expect(await adapter.isSwapExecutor(MAINNET_EXECUTOR.toLowerCase() as Address)).toBe(true);
    });

    it("identifies an unlisted Executor by its erc20Proxy() answer; a revert is not one", async () => {
        const adapter = adapterAnswering((address) => {
            if (address === SWAP) return PROXY;
            if (address === APPROVAL) return "0x0000000000000000000000000000000000000000";
            throw wrappedReadError(
                address,
                new ContractFunctionRevertedError({
                    abi: LIFI_EXECUTOR_SCREENING_ABI,
                    functionName: "erc20Proxy",
                    message: "execution reverted",
                }),
            );
        });
        expect(await adapter.isSwapExecutor(SWAP)).toBe(true);
        expect(await adapter.isSwapExecutor(APPROVAL)).toBe(false);
        expect(await adapter.isSwapExecutor(TOKEN)).toBe(false);
    });

    it("treats a revert without data and an empty return as not an executor", async () => {
        const failures = [
            new ExecutionRevertedError({ message: "execution reverted" }),
            new ContractFunctionZeroDataError({ functionName: "erc20Proxy" }),
        ];
        for (const failure of failures) {
            const adapter = adapterAnswering((address) => {
                throw wrappedReadError(address, failure);
            });
            expect(await adapter.isSwapExecutor(SWAP)).toBe(false);
        }
    });

    it("rejects transport and non-viem failures, without caching failed probes", async () => {
        const transport = wrappedReadError(
            SWAP,
            new HttpRequestError({ status: 503, url: "https://example.com/rpc" }),
        );
        const adapter = adapterAnswering(() => {
            throw transport;
        });
        await expect(adapter.isSwapExecutor(SWAP)).rejects.toBe(transport);

        const failure = new Error("fetch failed");
        let reads = 0;
        const retryAdapter = adapterAnswering(() => {
            if (reads++ === 0) throw failure;
            return PROXY;
        });
        await expect(retryAdapter.isSwapExecutor(SWAP)).rejects.toBe(failure);
        await expect(retryAdapter.isSwapExecutor(SWAP)).resolves.toBe(true);
        expect(reads).toBe(2);
    });
});
