import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";

/**
 * Encodes LiFi StargateFacetV2 `swapAndStartBridgeTokensViaStargate` calldata
 * (selector 0xa6010a66, verified against live calldata 2026-08-31) for unit tests
 * that need `decodeStargateDestBudget` to exercise real decoding. Thread the
 * flow-under-test's containment bytes (padded Entrypoint + deposit calldata)
 * through `composeMsg` so byte-containment checks still pass.
 */
export function encodeStargateMainLegCalldata(args: {
    minAmountLD: bigint;
    composeMsg: Hex;
    executor?: Address;
}): Hex {
    const executor = args.executor ?? "0x00000000000000000000000000000000B2b2b2b2";
    return encodeFunctionData({
        abi: STARGATE_FACET_TEST_ABI,
        functionName: "swapAndStartBridgeTokensViaStargate",
        args: [
            {
                transactionId: `0x${"11".repeat(32)}` as Hex,
                bridge: "stargateV2",
                integrator: "test",
                referrer: "0x0000000000000000000000000000000000000000" as Address,
                sendingAssetId: executor,
                receiver: executor,
                minAmount: 1n,
                destinationChainId: 1n,
                hasSourceSwaps: false,
                hasDestinationCall: true,
            },
            [],
            {
                assetId: 1,
                sendParams: {
                    dstEid: 30101,
                    to: `0x${executor.slice(2).toLowerCase().padStart(64, "0")}` as Hex,
                    amountLD: args.minAmountLD + 1_000n,
                    minAmountLD: args.minAmountLD,
                    extraOptions: "0x" as Hex,
                    composeMsg: args.composeMsg,
                    oftCmd: "0x" as Hex,
                },
                fee: { nativeFee: 10_000n, lzTokenFee: 0n },
                refundAddress: executor,
            },
        ],
    });
}

const STARGATE_FACET_TEST_ABI = [
    {
        type: "function",
        name: "swapAndStartBridgeTokensViaStargate",
        stateMutability: "payable",
        inputs: [
            {
                name: "_bridgeData",
                type: "tuple",
                components: [
                    { name: "transactionId", type: "bytes32" },
                    { name: "bridge", type: "string" },
                    { name: "integrator", type: "string" },
                    { name: "referrer", type: "address" },
                    { name: "sendingAssetId", type: "address" },
                    { name: "receiver", type: "address" },
                    { name: "minAmount", type: "uint256" },
                    { name: "destinationChainId", type: "uint256" },
                    { name: "hasSourceSwaps", type: "bool" },
                    { name: "hasDestinationCall", type: "bool" },
                ],
            },
            {
                name: "_swapData",
                type: "tuple[]",
                components: [
                    { name: "callTo", type: "address" },
                    { name: "approveTo", type: "address" },
                    { name: "sendingAssetId", type: "address" },
                    { name: "receivingAssetId", type: "address" },
                    { name: "fromAmount", type: "uint256" },
                    { name: "callData", type: "bytes" },
                    { name: "requiresDeposit", type: "bool" },
                ],
            },
            {
                name: "_stargateData",
                type: "tuple",
                components: [
                    { name: "assetId", type: "uint16" },
                    {
                        name: "sendParams",
                        type: "tuple",
                        components: [
                            { name: "dstEid", type: "uint32" },
                            { name: "to", type: "bytes32" },
                            { name: "amountLD", type: "uint256" },
                            { name: "minAmountLD", type: "uint256" },
                            { name: "extraOptions", type: "bytes" },
                            { name: "composeMsg", type: "bytes" },
                            { name: "oftCmd", type: "bytes" },
                        ],
                    },
                    {
                        name: "fee",
                        type: "tuple",
                        components: [
                            { name: "nativeFee", type: "uint256" },
                            { name: "lzTokenFee", type: "uint256" },
                        ],
                    },
                    { name: "refundAddress", type: "address" },
                ],
            },
        ],
        outputs: [],
    },
] as const;
