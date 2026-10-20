import type { Address, Hex } from "viem";
import { encodeAbiParameters, encodeFunctionData, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";

import { decodeLiFiDestinationCallAmount } from "../../../src/internal.js";

// LiFi's destination-leg payload as every receiver decodes it:
// abi.encode(bytes32 transactionId, LibSwap.SwapData[] swaps, address receiver).
const PAYLOAD = parseAbiParameters(
    "bytes32 transactionId, (address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[] swaps, address receiver",
);

const DEX = "0xBc1D9760bd6ca468CA9fB5Ff2CFbEAC35d86c973" as Address;
const ENTRYPOINT = "0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3" as Address;
const USDC_BSC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Address;
const NATIVE0 = "0x0000000000000000000000000000000000000000" as Address;
const FALLBACK = "0x9e2f1B234953F46c6091636290E9035618EA3C07" as Address;
const TX_ID = `0x${"58".repeat(32)}` as Hex;

const DEPOSIT_CALLDATA = ("0xc63148e8" + "ab".repeat(700)) as Hex;
const DEX_CALLDATA = ("0x46ec278a" + "cd".repeat(400)) as Hex;

function destinationMessage(depositCallData: Hex, encodedFromAmount: bigint): Hex {
    return encodeAbiParameters(PAYLOAD, [
        TX_ID,
        [
            {
                callTo: DEX,
                approveTo: DEX,
                sendingAssetId: USDC_BSC,
                receivingAssetId: NATIVE0,
                fromAmount: 29_754_909_000_000_000_000n,
                callData: DEX_CALLDATA,
                requiresDeposit: true,
            },
            {
                callTo: ENTRYPOINT,
                approveTo: ENTRYPOINT,
                sendingAssetId: NATIVE0,
                receivingAssetId: NATIVE0,
                fromAmount: encodedFromAmount,
                callData: depositCallData,
                requiresDeposit: false,
            },
        ],
        FALLBACK,
    ]);
}

// A stand-in for an Across facet call: the message sits inside a bytes field of a struct,
// behind other dynamic data, exactly where the real diamond calldata puts it.
const FACET_ABI = [
    {
        type: "function",
        name: "startBridgeTokensViaAcrossV3",
        stateMutability: "payable",
        inputs: [
            {
                name: "_bridgeData",
                type: "tuple",
                components: [
                    { name: "transactionId", type: "bytes32" },
                    { name: "bridge", type: "string" },
                    { name: "integrator", type: "string" },
                    { name: "receiver", type: "address" },
                    { name: "minAmount", type: "uint256" },
                    { name: "destinationChainId", type: "uint256" },
                ],
            },
            {
                name: "_acrossData",
                type: "tuple",
                components: [
                    { name: "receiverAddress", type: "address" },
                    { name: "outputAmount", type: "uint256" },
                    { name: "message", type: "bytes" },
                ],
            },
        ],
        outputs: [],
    },
] as const;

function diamondCalldata(message: Hex): Hex {
    return encodeFunctionData({
        abi: FACET_ABI,
        functionName: "startBridgeTokensViaAcrossV3",
        args: [
            {
                transactionId: TX_ID,
                bridge: "across",
                integrator: "privacy-pools-v2",
                receiver: "0x33b255b5db44A78c34381f89f1a454bc0Ef49871",
                minAmount: 29_881_865n,
                destinationChainId: 56n,
            },
            {
                receiverAddress: "0x33b255b5db44A78c34381f89f1a454bc0Ef49871",
                outputAmount: 29_754_909_000_000_000_000n,
                message,
            },
        ],
    });
}

describe("decodeLiFiDestinationCallAmount", () => {
    it("return the fromAmount LiFi encoded for our destination call inside an Across message", () => {
        const encoded = 36_870_531_643_572_856n; // what LiFi wrote on 2026-09-24 for a 0.038028 BNB request
        const data = diamondCalldata(destinationMessage(DEPOSIT_CALLDATA, encoded));
        expect(decodeLiFiDestinationCallAmount(data, DEPOSIT_CALLDATA)).toBe(encoded);
    });

    it("match our call by calldata, not by position: the DEX step's amount is never returned", () => {
        const data = diamondCalldata(destinationMessage(DEPOSIT_CALLDATA, 1n));
        expect(decodeLiFiDestinationCallAmount(data, DEX_CALLDATA)).toBe(
            29_754_909_000_000_000_000n,
        );
        expect(decodeLiFiDestinationCallAmount(data, DEPOSIT_CALLDATA)).toBe(1n);
    });

    it("return undefined when the calldata embeds no destination payload with our call", () => {
        const data = diamondCalldata(destinationMessage(DEX_CALLDATA, 5n));
        expect(decodeLiFiDestinationCallAmount(data, DEPOSIT_CALLDATA)).toBeUndefined();
        expect(
            decodeLiFiDestinationCallAmount("0xdeadbeef" as Hex, DEPOSIT_CALLDATA),
        ).toBeUndefined();
        expect(decodeLiFiDestinationCallAmount(data, "0x" as Hex)).toBeUndefined();
    });

    it("read a payload that is the whole calldata tail, as a compose message would be", () => {
        const message = destinationMessage(DEPOSIT_CALLDATA, 123n);
        const data = `0xdeadbeef${"00".repeat(32)}${message.slice(2)}` as Hex;
        expect(decodeLiFiDestinationCallAmount(data, DEPOSIT_CALLDATA)).toBe(123n);
    });
});
