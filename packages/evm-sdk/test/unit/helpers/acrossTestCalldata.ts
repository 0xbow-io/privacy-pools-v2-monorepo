import type { Hex } from "viem";
import {
    decodeAbiParameters,
    decodeFunctionData,
    encodeAbiParameters,
    encodeFunctionData,
    pad,
    parseAbi,
    parseAbiParameters,
} from "viem";

/** LiFi's AcrossFacetV4 entry points, as the SDK decodes them. */
export const ACROSS_FACET_V4_ABI = parseAbi([
    "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
    "struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }",
    "struct AcrossV4Data { bytes32 receiverAddress; bytes32 refundAddress; bytes32 sendingAssetId; bytes32 receivingAssetId; uint256 outputAmount; uint128 outputAmountMultiplier; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
    "function startBridgeTokensViaAcrossV4(BridgeData _bridgeData, AcrossV4Data _acrossData)",
    "function swapAndStartBridgeTokensViaAcrossV4(BridgeData _bridgeData, SwapData[] _swapData, AcrossV4Data _acrossData)",
]);

const PAYLOAD = parseAbiParameters(
    "bytes32 transactionId, (address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[] swaps, address receiver",
);

export const DEPOSIT_CALLDATA =
    "0xdeadbeef0000000000000000000000000000000000000000000000000000002a" as Hex;
export const POOL = "0x5555555555555555555555555555555555555555" as const;
export const DEX = "0x6666666666666666666666666666666666666666" as const;
export const SRC_TOKEN = "0x1111111111111111111111111111111111111111" as const;
export const BRIDGED_TOKEN = "0x2222222222222222222222222222222222222222" as const;
export const DEST_TOKEN = "0x3333333333333333333333333333333333333333" as const;
export const RECEIVER_ACROSS = "0x4444444444444444444444444444444444444444" as const;
export const FALLBACK = "0x7777777777777777777777777777777777777777" as const;
export const REFUND = "0x8888888888888888888888888888888888888888" as const;
export const TX_FULL = pad("0x01") as Hex;
export const TX_REDUCED = pad("0x02") as Hex;

export interface DestSwap {
    callTo: `0x${string}`;
    approveTo: `0x${string}`;
    sendingAssetId: `0x${string}`;
    receivingAssetId: `0x${string}`;
    fromAmount: bigint;
    callData: Hex;
    requiresDeposit: boolean;
}

/** Our pool deposit as the last destination payload entry. */
export const ourCall = (fromAmount: bigint, token: `0x${string}` = DEST_TOKEN): DestSwap => ({
    callTo: POOL,
    approveTo: POOL,
    sendingAssetId: token,
    receivingAssetId: token,
    fromAmount,
    callData: DEPOSIT_CALLDATA,
    requiresDeposit: false,
});

/** A destination DEX swap between the bridged token and the pool token. */
export const dexSwap = (fromAmount: bigint): DestSwap => ({
    callTo: DEX,
    approveTo: DEX,
    sendingAssetId: BRIDGED_TOKEN,
    receivingAssetId: DEST_TOKEN,
    fromAmount,
    callData: "0x12345678",
    requiresDeposit: true,
});

export interface AcrossTxOptions {
    txId?: Hex;
    payloadTxId?: Hex;
    minAmount: bigint;
    outputAmount: bigint;
    multiplier?: bigint;
    sourceSwap?: boolean;
    swaps: DestSwap[];
    payloadReceiver?: `0x${string}`;
    bridgeSendingAsset?: `0x${string}`;
    acrossSendingAsset?: `0x${string}`;
    acrossReceivingAsset?: `0x${string}`;
    acrossReceiver?: `0x${string}`;
    refund?: `0x${string}`;
    destinationChainId?: bigint;
    hasDestinationCall?: boolean;
}

/** LiFi diamond calldata for an AcrossFacetV4 bridge whose payload ends in `swaps`. */
export function acrossTx(o: AcrossTxOptions): Hex {
    const txId = o.txId ?? TX_FULL;
    const message = encodeAbiParameters(PAYLOAD, [
        o.payloadTxId ?? txId,
        o.swaps,
        o.payloadReceiver ?? FALLBACK,
    ]);
    const bridgeData = {
        transactionId: txId,
        bridge: "across",
        integrator: "test",
        referrer: "0x0000000000000000000000000000000000000000",
        sendingAssetId: o.bridgeSendingAsset ?? BRIDGED_TOKEN,
        receiver: RECEIVER_ACROSS,
        minAmount: o.minAmount,
        destinationChainId: o.destinationChainId ?? 56n,
        hasSourceSwaps: !!o.sourceSwap,
        hasDestinationCall: o.hasDestinationCall ?? true,
    } as const;
    const across = {
        receiverAddress: pad(o.acrossReceiver ?? RECEIVER_ACROSS),
        refundAddress: pad(o.refund ?? REFUND),
        sendingAssetId: pad(o.acrossSendingAsset ?? BRIDGED_TOKEN),
        receivingAssetId: pad(o.acrossReceivingAsset ?? BRIDGED_TOKEN),
        outputAmount: o.outputAmount,
        outputAmountMultiplier: o.multiplier ?? 0n,
        exclusiveRelayer: pad("0x00"),
        quoteTimestamp: 1,
        fillDeadline: 2,
        exclusivityParameter: 0,
        message,
    };
    if (o.sourceSwap) {
        return encodeFunctionData({
            abi: ACROSS_FACET_V4_ABI,
            functionName: "swapAndStartBridgeTokensViaAcrossV4",
            args: [
                bridgeData,
                [
                    {
                        callTo: DEX,
                        approveTo: DEX,
                        sendingAssetId: SRC_TOKEN,
                        receivingAssetId: BRIDGED_TOKEN,
                        fromAmount: o.minAmount,
                        callData: "0xabcdef01",
                        requiresDeposit: true,
                    },
                ],
                across,
            ],
        });
    }
    return encodeFunctionData({
        abi: ACROSS_FACET_V4_ABI,
        functionName: "startBridgeTokensViaAcrossV4",
        args: [bridgeData, across],
    });
}

/** Decodes LiFi diamond calldata built by {@link acrossTx}. */
export function decodeAcrossTx(data: Hex) {
    const decoded = decodeFunctionData({ abi: ACROSS_FACET_V4_ABI, data });
    const sourceSwaps =
        decoded.functionName === "swapAndStartBridgeTokensViaAcrossV4"
            ? decoded.args[1]
            : undefined;
    const across =
        decoded.functionName === "swapAndStartBridgeTokensViaAcrossV4"
            ? decoded.args[2]
            : decoded.args[1];
    const [txId, swaps, receiver] = decodeAbiParameters(PAYLOAD, across.message);
    return {
        functionName: decoded.functionName,
        bridgeData: decoded.args[0],
        sourceSwaps,
        across,
        payload: { txId, swaps, receiver },
    };
}

/** A LiFi `includedSteps` Across leg carrying a relayer gas fee in the leg's input token. */
export const acrossLegStep = (
    fromAmount: bigint,
    toAmount: bigint,
    gasFee: bigint | undefined,
    feeToken: `0x${string}` = BRIDGED_TOKEN,
    tool = "across",
) => ({
    tool,
    action: { fromToken: { address: BRIDGED_TOKEN } },
    estimate: {
        fromAmount: fromAmount.toString(),
        toAmount: toAmount.toString(),
        feeCosts:
            gasFee === undefined
                ? []
                : [
                      {
                          name: "Relayer gas fee",
                          amount: gasFee.toString(),
                          token: { address: feeToken },
                      },
                  ],
    },
});
