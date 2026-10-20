import type { Hex } from "viem";
import { decodeAbiParameters, parseAbiParameters } from "viem";

/**
 * LiFi's destination-leg payload, as every LiFi receiver decodes it
 * (`ReceiverAcrossV3/V4.handleV3AcrossMessage`, `ReceiverStargateV2.lzCompose`, …):
 * `abi.encode(bytes32 transactionId, LibSwap.SwapData[] swaps, address receiver)`.
 * The last `SwapData` is our destination contract call; its `fromAmount` is what the
 * Executor hands the call — as `msg.value` for a native-coin call, as the approval
 * amount for an ERC-20 call.
 */
const DESTINATION_PAYLOAD = parseAbiParameters(
    "bytes32 transactionId, (address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[] swaps, address receiver",
);

/** Upper bound on the SwapData entries a sane destination leg carries (bridge → ≤ 2 swaps → call). */
const MAX_DESTINATION_SWAPS = 8;

/**
 * Extracts the `fromAmount` LiFi encoded for OUR destination contract call from a LiFi
 * diamond calldata (`transactionRequest.data`), by locating the destination payload that
 * embeds `depositCallData` verbatim.
 *
 * Measured 2026-09-23/24 against li.quest on mainnet → Optimism / Base / Arbitrum / BSC:
 * LiFi ignores `contractCalls[].fromAmount` and always encodes the route's guaranteed
 * delivery (the last swap step's `toAmountMin`, or the bridge's minimum when there is no
 * destination swap). For a native-coin call the Executor sends exactly this value as
 * `msg.value`; for an ERC-20 call it only sizes the approval (LiFi max-approves), the
 * call may pull up to the Executor's full balance.
 *
 * @param transactionData - The full LiFi diamond calldata.
 * @param depositCallData - Our destination call's calldata (the one embedded in the quote).
 * @returns The encoded `fromAmount`, or `undefined` when no destination payload embedding
 *   `depositCallData` is found (a same-chain quote, or an unrecognised payload layout).
 */
export function decodeLiFiDestinationCallAmount(
    transactionData: Hex,
    depositCallData: Hex,
): bigint | undefined {
    const hex = transactionData.slice(2);
    const needle = depositCallData.slice(2).toLowerCase();
    if (needle.length === 0) return undefined;
    // ABI heads are 32-byte aligned; the payload sits somewhere after the 4-byte selector.
    for (let offset = 8; offset + 64 * 4 <= hex.length; offset += 64) {
        let swaps;
        try {
            [, swaps] = decodeAbiParameters(DESTINATION_PAYLOAD, `0x${hex.slice(offset)}` as Hex);
        } catch {
            continue;
        }
        if (swaps.length === 0 || swaps.length > MAX_DESTINATION_SWAPS) continue;
        const ours = swaps.find((s) => s.callData.slice(2).toLowerCase() === needle);
        if (ours) return ours.fromAmount;
    }
    return undefined;
}
