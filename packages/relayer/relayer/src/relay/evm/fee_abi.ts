import { decodeAbiParameters, encodeAbiParameters } from "viem";
import type { Address, Hex } from "viem";
import { Bytes, FeeSplit } from "./types";

const feeSplitParams = [
    {
        type: "tuple",
        components: [
            { name: "recipient", type: "address" },
            { name: "feeRecipient", type: "address" },
            { name: "feeAmount", type: "uint256" },
            { name: "nativeGas", type: "uint256" },
        ],
    },
] as const;

// ABI for the WHOLE batch of PayoutRouting structs, encoded as `PayoutRouting[]`.
// This is what the batch fee commitment's `data` carries; PrivacyPoolRelay.relayBatch
// decodes each item's `_transactParams[i].data` as a single PayoutRouting.
const feeSplitArrayParams = [
    {
        type: "tuple[]",
        components: [
            { name: "recipient", type: "address" },
            { name: "feeRecipient", type: "address" },
            { name: "feeAmount", type: "uint256" },
            { name: "nativeGas", type: "uint256" },
        ],
    },
] as const;

/**
 * Encodes a FeeSplit struct into bytes for relay withdrawal's `_transactParams.data`.
 */
export function encodeWithdrawalFeeSplit(recipient: Address, feeRecipient: Address, feeAmount: bigint, nativeGas = 0n): Bytes {
    return encodeAbiParameters(feeSplitParams, [{ recipient, feeRecipient, feeAmount, nativeGas }]);
}

/**
 * Encodes a FeeSplit struct into bytes for private transfer's `_transactParams.data`.
 */
export function encodeTransferFeeSplit(feeRecipient: Address): Bytes {
    const feeAmount = 0n; // XXX: feeAmount is actually amountOut in public signals for internal transfers, and recipient is the feeRecipient
    return encodeAbiParameters(feeSplitParams, [{ recipient: feeRecipient, feeRecipient, feeAmount, nativeGas: 0n }]);
}

/**
 * Decodes FeeSplit bytes into FeeSplit struct.
 */
export function decodeFeeSplit(data: Bytes): FeeSplit {
    return decodeAbiParameters(feeSplitParams, data)[0];
}

/**
 * Encodes an array of FeeSplit (PayoutRouting) structs into bytes for the batch
 * fee commitment's `data`. The relayer signs this over the whole batch, then
 * re-encodes each element individually into `_transactParams[i].data` for relayBatch.
 */
export function encodeBatchFeeSplit(routings: FeeSplit[]): Bytes {
    return encodeAbiParameters(feeSplitArrayParams, [routings]);
}

/**
 * Decodes the batch fee commitment `data` bytes into a PayoutRouting[] array.
 */
export function decodeBatchFeeSplit(data: Bytes): FeeSplit[] {
    return decodeAbiParameters(feeSplitArrayParams, data)[0] as FeeSplit[];
}

/**
 * Builds the TransactParams tuple for `relayWithdrawal`.
 * `processor` is the relay contract address that will process the withdrawal.
 */
export function buildWithdrawalTransactParams(
    processor: Address,
    recipient: Address,
    feeRecipient: Address,
    feeAmount: bigint,
    nativeGas = 0n
): { processor: Address; data: Hex } {
    return {
        processor,
        data: encodeWithdrawalFeeSplit(recipient, feeRecipient, feeAmount, nativeGas),
    };
}

/**
 * Builds the TransactParams tuple for `relayTransfer`. //TBD
 * `processor` is the relay contract address that will process the private transfer.
 */
export function buildTransferTransactParams(
    processor: Address,
    feeRecipient: Address,
    _feeAmount: bigint
): { processor: Address; data: Hex } {
    return {
        processor,
        data: encodeTransferFeeSplit(feeRecipient),
    };
}
