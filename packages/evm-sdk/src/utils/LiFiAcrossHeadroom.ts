import type { Hex } from "viem";
import {
    decodeAbiParameters,
    decodeFunctionData,
    encodeAbiParameters,
    encodeFunctionData,
    parseAbi,
    parseAbiParameters,
} from "viem";

/**
 * Extra relayer gas allowance on an Across leg that ends in our destination call, as a share
 * of the relayer gas fee LiFi quoted (5_000 = half that fee again). The filler keeps every unit
 * of it and nothing is refunded, so it is sized to the miss measured below with room for gas to
 * move between the quote and the fill, not more.
 *
 * LiFi builds the Across deposit with no headroom: `outputAmount` is the input minus exactly the
 * fee Across suggested at quote time. A fill that runs our deposit (a Groth16 verify and a
 * LeanIMT insert) is gas-heavy, and when the filler's own estimate at fill time comes out above
 * the quote, no relayer fills, the deposit expires and Across refunds the RelaySwaps processor.
 * Measured on an Optimism to BNB Chain reshield (deposit 3815725, 2026-10-13): the deposit left
 * the filler 0.0339 USDT, about 0.0204 of it for gas, while Across's suggested-fees for that
 * exact message asks 0.0393 of which 0.0258 is gas (27% over the quote's gas allowance), and it
 * was never filled.
 */
export const ACROSS_RELAYER_GAS_HEADROOM_BPS = 5_000n;

/** LiFi's AcrossFacetV4 entry points (lifinance/contracts `src/Facets/AcrossFacetV4.sol`). */
const ACROSS_FACET_V4_ABI = parseAbi([
    "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
    "struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }",
    "struct AcrossV4Data { bytes32 receiverAddress; bytes32 refundAddress; bytes32 sendingAssetId; bytes32 receivingAssetId; uint256 outputAmount; uint128 outputAmountMultiplier; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
    "function startBridgeTokensViaAcrossV4(BridgeData _bridgeData, AcrossV4Data _acrossData)",
    "function swapAndStartBridgeTokensViaAcrossV4(BridgeData _bridgeData, SwapData[] _swapData, AcrossV4Data _acrossData)",
]);

/** `AcrossFacetV4.MULTIPLIER_BASE`. */
const MULTIPLIER_BASE = 10n ** 18n;

/** The destination payload LiFi's receivers decode (see LiFiDestinationCall.ts). */
const DESTINATION_PAYLOAD = parseAbiParameters(
    "bytes32 transactionId, (address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[] swaps, address receiver",
);

interface DestinationSwap {
    callTo: `0x${string}`;
    approveTo: `0x${string}`;
    sendingAssetId: `0x${string}`;
    receivingAssetId: `0x${string}`;
    fromAmount: bigint;
    callData: Hex;
    requiresDeposit: boolean;
}

/** An AcrossFacetV4 call with its destination payload decoded, or `undefined` for anything else. */
function decodeAcrossCall(transactionData: Hex) {
    let decoded;
    try {
        decoded = decodeFunctionData({
            abi: ACROSS_FACET_V4_ABI,
            data: transactionData,
        });
    } catch {
        return undefined;
    }
    const sourceSwaps =
        decoded.functionName === "swapAndStartBridgeTokensViaAcrossV4"
            ? decoded.args[1]
            : undefined;
    const across =
        decoded.functionName === "swapAndStartBridgeTokensViaAcrossV4"
            ? decoded.args[2]
            : decoded.args[1];
    let txId: Hex;
    let swaps: readonly DestinationSwap[];
    let receiver: `0x${string}`;
    try {
        [txId, swaps, receiver] = decodeAbiParameters(DESTINATION_PAYLOAD, across.message);
    } catch {
        return undefined;
    }
    return {
        bridgeData: decoded.args[0],
        sourceSwaps,
        across,
        payload: { txId, swaps, receiver },
    };
}

type AcrossCall = NonNullable<ReturnType<typeof decodeAcrossCall>>;

function encodeAcrossCall(
    call: AcrossCall,
    bridgeData: AcrossCall["bridgeData"],
    across: AcrossCall["across"],
): Hex {
    return call.sourceSwaps
        ? encodeFunctionData({
              abi: ACROSS_FACET_V4_ABI,
              functionName: "swapAndStartBridgeTokensViaAcrossV4",
              args: [bridgeData, call.sourceSwaps, across],
          })
        : encodeFunctionData({
              abi: ACROSS_FACET_V4_ABI,
              functionName: "startBridgeTokensViaAcrossV4",
              args: [bridgeData, across],
          });
}

/** Our call when it is the last entry of the destination payload, else `undefined`. */
function ourCall(call: AcrossCall, depositCallData: Hex): DestinationSwap | undefined {
    const last = call.payload.swaps.at(-1);
    return last && last.callData.toLowerCase() === depositCallData.toLowerCase() ? last : undefined;
}

/**
 * Lowers what an Across leg delivers by `headroom` (destination token units), so the filler
 * keeps that much more, and lowers our destination call's encoded `fromAmount` by the same
 * amount so LiFi's Executor still holds what the call asks for.
 *
 * `swapAndStartBridgeTokensViaAcrossV4` recomputes `outputAmount` on chain as
 * `minAmount * outputAmountMultiplier / 1e18` after its source swaps, so the multiplier is
 * scaled with it; `startBridgeTokensViaAcrossV4` uses `outputAmount` as given.
 *
 * Returns `undefined`, leaving the quote as LiFi built it, when the calldata is not an
 * AcrossFacetV4 call, when the destination payload is anything other than our call alone
 * (a destination swap sits between the bridge and the call and owns its own amounts; see
 * {@link spliceAcrossFillHeadroom}), or when the headroom would consume the whole delivery.
 *
 * @param transactionData - The full LiFi diamond calldata.
 * @param depositCallData - Our destination call's calldata, embedded in the payload.
 * @param headroom - What to leave the filler on top of LiFi's quote, in destination token units.
 * @returns The patched calldata and the call's new encoded `fromAmount`, and
 *   `reduction`, how much less the leg now delivers (destination token units).
 */
export function applyAcrossFillHeadroom(
    transactionData: Hex,
    depositCallData: Hex,
    headroom: bigint,
): { transactionData: Hex; destinationCallAmount: bigint; reduction: bigint } | undefined {
    if (headroom <= 0n) return undefined;

    const call = decodeAcrossCall(transactionData);
    if (!call) return undefined;
    const { bridgeData, across, payload } = call;

    const outputAmount = across.outputAmount;
    if (headroom >= outputAmount) return undefined;
    const reducedTarget = outputAmount - headroom;

    let newMultiplier = across.outputAmountMultiplier;
    let newOutput = reducedTarget;
    if (call.sourceSwaps) {
        newMultiplier = (across.outputAmountMultiplier * reducedTarget) / outputAmount;
        // What the facet will compute on chain from the quoted post-swap amount.
        newOutput = (bridgeData.minAmount * newMultiplier) / MULTIPLIER_BASE;
    }

    const ours = ourCall(call, depositCallData);
    if (payload.swaps.length !== 1 || !ours || ours.fromAmount > outputAmount) {
        return undefined;
    }
    const callAmount = ours.fromAmount - (outputAmount - newOutput);
    if (callAmount <= 0n) return undefined;

    const message = encodeAbiParameters(DESTINATION_PAYLOAD, [
        payload.txId,
        [{ ...ours, fromAmount: callAmount }],
        payload.receiver,
    ]);
    const patched = encodeAcrossCall(call, bridgeData, {
        ...across,
        outputAmount: newOutput,
        outputAmountMultiplier: newMultiplier,
        message,
    });
    return {
        transactionData: patched,
        destinationCallAmount: callAmount,
        reduction: outputAmount - newOutput,
    };
}

/**
 * Whether `transactionData` is an AcrossFacetV4 call whose destination payload runs at least one
 * swap before our call. {@link applyAcrossFillHeadroom} cannot patch that layout: the swap's
 * amount is fixed in the aggregator's calldata, and a smaller delivery reverts it and sends the
 * bridged funds to the fallback address. {@link spliceAcrossFillHeadroom} covers it instead.
 */
export function hasAcrossDestinationSwap(transactionData: Hex, depositCallData: Hex): boolean {
    const call = decodeAcrossCall(transactionData);
    return !!call && call.payload.swaps.length > 1 && !!ourCall(call, depositCallData);
}

/**
 * Leaves an Across filler headroom on a route LiFi cannot lower after the fact, by combining two
 * quotes for the same request: `full` for the whole input, and `reduced` for the input less the
 * headroom. The source side (BridgeData and source swaps) comes from `full`, so the whole input
 * is deposited; the Across leg and the destination payload come from `reduced`, so the filler
 * delivers what LiFi priced for the smaller input and the destination swap and our call are
 * built by LiFi for exactly that delivery. The filler keeps the difference: its quoted fee plus
 * the headroom.
 *
 * `swapAndStartBridgeTokensViaAcrossV4` recomputes the delivery on chain as
 * `minAmount * outputAmountMultiplier / 1e18`, so the multiplier is set against `full`'s
 * `minAmount`, rounded up so the delivery is at least `reduced`'s. A larger post-swap amount
 * raises the delivery proportionally, as it would on either quote alone; the Executor returns
 * whatever the destination swap does not consume to the payload's receiver.
 *
 * `BridgeData.transactionId` is taken from `reduced`, so it matches the destination payload
 * LiFi encoded with it (each quote carries its own id, the same in both places).
 *
 * Returns `undefined` when the two quotes cannot be combined: either is not an AcrossFacetV4
 * call ending in our call, they bridge a different token on either side, between different
 * chains, or through a different receiver, refund address or fallback, either quote's ids
 * disagree, the combined delivery would not cover the destination's first step, or it leaves
 * the filler no more than `full` did.
 *
 * @param full - LiFi diamond calldata quoted for the whole input.
 * @param reduced - LiFi diamond calldata quoted for the input less the headroom.
 * @param depositCallData - Our destination call's calldata, embedded in both payloads.
 * @returns The combined calldata and the call's encoded `fromAmount` in it.
 */
export function spliceAcrossFillHeadroom(
    full: Hex,
    reduced: Hex,
    depositCallData: Hex,
): { transactionData: Hex; destinationCallAmount: bigint } | undefined {
    const source = decodeAcrossCall(full);
    const leg = decodeAcrossCall(reduced);
    if (!source || !leg) return undefined;
    const ours = ourCall(leg, depositCallData);
    const [first] = leg.payload.swaps;
    if (!ourCall(source, depositCallData) || !ours || !first) return undefined;

    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (
        source.payload.txId !== source.bridgeData.transactionId ||
        leg.payload.txId !== leg.bridgeData.transactionId ||
        !same(source.bridgeData.sendingAssetId, leg.bridgeData.sendingAssetId) ||
        source.bridgeData.destinationChainId !== leg.bridgeData.destinationChainId ||
        !source.bridgeData.hasDestinationCall ||
        !leg.bridgeData.hasDestinationCall ||
        !same(source.across.sendingAssetId, leg.across.sendingAssetId) ||
        !same(source.across.receivingAssetId, leg.across.receivingAssetId) ||
        !same(source.across.receiverAddress, leg.across.receiverAddress) ||
        !same(source.across.refundAddress, leg.across.refundAddress) ||
        !same(source.payload.receiver, leg.payload.receiver)
    ) {
        return undefined;
    }

    const minAmount = source.bridgeData.minAmount;
    const target = leg.across.outputAmount;
    if (minAmount <= 0n || target <= 0n) return undefined;
    let outputAmount = target;
    let outputAmountMultiplier = source.across.outputAmountMultiplier;
    if (source.sourceSwaps) {
        const multiplier = (target * MULTIPLIER_BASE + minAmount - 1n) / minAmount;
        if (multiplier >= 1n << 128n) return undefined;
        outputAmountMultiplier = multiplier;
        outputAmount = (minAmount * multiplier) / MULTIPLIER_BASE;
    }
    // The delivery must fund the destination's first step, and must leave the filler more
    // than the full quote did, or there is nothing to gain from the splice.
    if (outputAmount < first.fromAmount || outputAmount >= source.across.outputAmount) {
        return undefined;
    }

    const transactionData = encodeAcrossCall(
        source,
        { ...source.bridgeData, transactionId: leg.bridgeData.transactionId },
        { ...leg.across, outputAmount, outputAmountMultiplier },
    );
    return { transactionData, destinationCallAmount: ours.fromAmount };
}

/**
 * The fill headroom for a LiFi step whose bridge is Across: the relayer gas fee LiFi quoted
 * for the Across leg, scaled by {@link ACROSS_RELAYER_GAS_HEADROOM_BPS} and converted to the
 * destination token at the leg's own quoted rate. `undefined` when the step has no Across leg
 * or its fee breakdown does not carry the gas fee in the leg's input token.
 */
export function acrossFillHeadroomFor(
    includedSteps: readonly AcrossHeadroomStep[] | undefined,
): bigint | undefined {
    const leg = acrossLeg(includedSteps);
    if (!leg) return undefined;
    return (leg.gasFee * leg.legOut * ACROSS_RELAYER_GAS_HEADROOM_BPS) / (leg.legIn * 10_000n);
}

/**
 * The same headroom as {@link acrossFillHeadroomFor}, in the units of the step's own input
 * (`stepFromAmount`), converted at the ratio of that input to what reaches the Across leg.
 * This is what {@link spliceAcrossFillHeadroom}'s reduced quote takes off the input.
 */
export function acrossFillHeadroomInputFor(
    includedSteps: readonly AcrossHeadroomStep[] | undefined,
    stepFromAmount: bigint,
): bigint | undefined {
    const leg = acrossLeg(includedSteps);
    if (!leg) return undefined;
    return (leg.gasFee * stepFromAmount * ACROSS_RELAYER_GAS_HEADROOM_BPS) / (leg.legIn * 10_000n);
}

/** The Across leg's quoted amounts and relayer gas fee, the fee in the leg's input token. */
function acrossLeg(includedSteps: readonly AcrossHeadroomStep[] | undefined) {
    const leg = includedSteps?.find((s) => s.tool === "across");
    if (!leg) return undefined;
    const gasFee = leg.estimate.feeCosts?.find((c) => c.name === "Relayer gas fee");
    if (
        !gasFee ||
        gasFee.token.address.toLowerCase() !== leg.action.fromToken.address.toLowerCase()
    ) {
        return undefined;
    }
    const legIn = BigInt(leg.estimate.fromAmount);
    const legOut = BigInt(leg.estimate.toAmount);
    if (legIn <= 0n || legOut <= 0n) return undefined;
    return { legIn, legOut, gasFee: BigInt(gasFee.amount) };
}

/** The subset of a LiFi `includedSteps` entry {@link acrossFillHeadroomFor} reads. */
export interface AcrossHeadroomStep {
    tool: string;
    action: { fromToken: { address: string } };
    estimate: {
        fromAmount: string;
        toAmount: string;
        feeCosts?: readonly {
            name: string;
            amount: string;
            token: { address: string };
        }[];
    };
}
