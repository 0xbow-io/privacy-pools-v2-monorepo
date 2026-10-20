import type { Hex } from "viem";
import { decodeFunctionData } from "viem";

const BRIDGE_DATA_COMPONENTS = [
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
] as const;

const SWAP_DATA_COMPONENTS = [
    { name: "callTo", type: "address" },
    { name: "approveTo", type: "address" },
    { name: "sendingAssetId", type: "address" },
    { name: "receivingAssetId", type: "address" },
    { name: "fromAmount", type: "uint256" },
    { name: "callData", type: "bytes" },
    { name: "requiresDeposit", type: "bool" },
] as const;

const STARGATE_DATA_COMPONENTS = [
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
] as const;

/**
 * Minimal ABI for LiFi's StargateFacetV2 entrypoints — enough to read the
 * destination-delivery guarantee (`sendParams.minAmountLD`) out of a main-leg
 * diamond calldata. Selectors verified against live calldata 2026-08-31:
 * 0xa6010a66 (swapAndStartBridgeTokensViaStargate), 0x14d53077
 * (startBridgeTokensViaStargate).
 */
const STARGATE_FACET_ABI = [
    {
        type: "function",
        name: "swapAndStartBridgeTokensViaStargate",
        stateMutability: "payable",
        inputs: [
            { name: "_bridgeData", type: "tuple", components: BRIDGE_DATA_COMPONENTS },
            { name: "_swapData", type: "tuple[]", components: SWAP_DATA_COMPONENTS },
            { name: "_stargateData", type: "tuple", components: STARGATE_DATA_COMPONENTS },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "startBridgeTokensViaStargate",
        stateMutability: "payable",
        inputs: [
            { name: "_bridgeData", type: "tuple", components: BRIDGE_DATA_COMPONENTS },
            { name: "_stargateData", type: "tuple", components: STARGATE_DATA_COMPONENTS },
        ],
        outputs: [],
    },
] as const;

/**
 * Extracts the bridge's guaranteed destination delivery (`sendParams.minAmountLD`)
 * from a Stargate-V2 main-leg diamond calldata. LiFi caps the destination
 * contract-call's budget at this amount, so a destination deposit costing more can
 * never succeed — even at full delivery.
 *
 * @param data - The full LiFi diamond calldata (`transactionRequest.data`).
 * @returns The minAmountLD, or `undefined` when the calldata is not a recognized
 *   Stargate-V2 facet call (e.g. an Across route — no LZ fee, no such cap).
 */
export function decodeStargateDestBudget(data: Hex): bigint | undefined {
    let args: readonly unknown[] | undefined;
    try {
        ({ args } = decodeFunctionData({ abi: STARGATE_FACET_ABI, data }));
    } catch {
        return undefined;
    }
    if (!args || args.length === 0) return undefined;
    const stargateData = args[args.length - 1] as {
        sendParams: { minAmountLD: bigint };
    };
    return stargateData.sendParams.minAmountLD;
}
