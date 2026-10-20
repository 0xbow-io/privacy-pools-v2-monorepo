import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import { decodeStargateDestBudget } from "../../../src/internal.js";

// Local mirror of LiFi's StargateFacetV2 signatures — the util's decoding must work
// against calldata encoded with the real facet shapes (selectors 0xa6010a66 and
// 0x14d53077, verified against live calldata 2026-08-31).
const BRIDGE_DATA = [
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

const SWAP_DATA = [
    { name: "callTo", type: "address" },
    { name: "approveTo", type: "address" },
    { name: "sendingAssetId", type: "address" },
    { name: "receivingAssetId", type: "address" },
    { name: "fromAmount", type: "uint256" },
    { name: "callData", type: "bytes" },
    { name: "requiresDeposit", type: "bool" },
] as const;

const STARGATE_DATA = [
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

const FACET_ABI = [
    {
        type: "function",
        name: "swapAndStartBridgeTokensViaStargate",
        stateMutability: "payable",
        inputs: [
            { name: "_bridgeData", type: "tuple", components: BRIDGE_DATA },
            { name: "_swapData", type: "tuple[]", components: SWAP_DATA },
            { name: "_stargateData", type: "tuple", components: STARGATE_DATA },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "startBridgeTokensViaStargate",
        stateMutability: "payable",
        inputs: [
            { name: "_bridgeData", type: "tuple", components: BRIDGE_DATA },
            { name: "_stargateData", type: "tuple", components: STARGATE_DATA },
        ],
        outputs: [],
    },
] as const;

const EXECUTOR = "0x00000000000000000000000000000000B2b2b2b2" as Address;
const TOKEN = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address;

interface BridgeDataArg {
    transactionId: Hex;
    bridge: string;
    integrator: string;
    referrer: Address;
    sendingAssetId: Address;
    receiver: Address;
    minAmount: bigint;
    destinationChainId: bigint;
    hasSourceSwaps: boolean;
    hasDestinationCall: boolean;
}

interface StargateDataArg {
    assetId: number;
    sendParams: {
        dstEid: number;
        to: Hex;
        amountLD: bigint;
        minAmountLD: bigint;
        extraOptions: Hex;
        composeMsg: Hex;
        oftCmd: Hex;
    };
    fee: { nativeFee: bigint; lzTokenFee: bigint };
    refundAddress: Address;
}

function bridgeData(): BridgeDataArg {
    return {
        transactionId: `0x${"11".repeat(32)}` as Hex,
        bridge: "stargateV2",
        integrator: "test",
        referrer: "0x0000000000000000000000000000000000000000" as Address,
        sendingAssetId: TOKEN,
        receiver: EXECUTOR,
        minAmount: 1n,
        destinationChainId: 1n,
        hasSourceSwaps: false,
        hasDestinationCall: true,
    };
}

function stargateData(minAmountLD: bigint): StargateDataArg {
    return {
        assetId: 1,
        sendParams: {
            dstEid: 30101,
            to: `0x${EXECUTOR.slice(2).toLowerCase().padStart(64, "0")}` as Hex,
            amountLD: minAmountLD + 1_000n,
            minAmountLD,
            extraOptions: "0x" as Hex,
            composeMsg: "0xdeadbeef" as Hex,
            oftCmd: "0x" as Hex,
        },
        fee: { nativeFee: 123n, lzTokenFee: 0n },
        refundAddress: EXECUTOR,
    };
}

describe("decodeStargateDestBudget", () => {
    it("read minAmountLD from swapAndStartBridgeTokensViaStargate calldata", () => {
        const data = encodeFunctionData({
            abi: FACET_ABI,
            functionName: "swapAndStartBridgeTokensViaStargate",
            args: [bridgeData(), [], stargateData(21_937_578n)],
        });
        expect(data.slice(0, 10)).toBe("0xa6010a66"); // live-verified selector
        expect(decodeStargateDestBudget(data)).toBe(21_937_578n);
    });

    it("read minAmountLD from startBridgeTokensViaStargate calldata", () => {
        const data = encodeFunctionData({
            abi: FACET_ABI,
            functionName: "startBridgeTokensViaStargate",
            args: [bridgeData(), stargateData(555n)],
        });
        expect(data.slice(0, 10)).toBe("0x14d53077"); // live-verified selector
        expect(decodeStargateDestBudget(data)).toBe(555n);
    });

    it("return undefined for a non-Stargate selector", () => {
        expect(decodeStargateDestBudget("0xdeadbeef00000000" as Hex)).toBeUndefined();
    });

    it("return undefined for a Stargate selector with malformed arguments", () => {
        expect(decodeStargateDestBudget("0xa6010a66ffff" as Hex)).toBeUndefined();
    });

    it("return undefined for empty calldata", () => {
        expect(decodeStargateDestBudget("0x" as Hex)).toBeUndefined();
    });
});
