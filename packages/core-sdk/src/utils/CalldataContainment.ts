import type { Hex } from "../internal.js";
import { LiFiDepositCalldataNotFound } from "../internal.js";

/**
 * Returns true when the raw bytes of `needle` appear verbatim inside `haystack`.
 *
 * Both arguments are hex strings; the `0x` prefix is stripped before comparison.
 * An empty needle (just `0x` or `""`) never matches — there is nothing to confirm.
 *
 * A DEX aggregator (e.g. LiFi) typically encodes `contractCalls` fields
 * (`toContractCallData`, `toContractAddress`) by copying them verbatim into the encoded
 * transaction blob without re-encoding or hashing. This means a hex substring search is
 * sufficient to verify their presence — no knowledge of the outer calldata structure is
 * required, so this check is chain-agnostic (unlike verifying an *address* is embedded, which
 * needs the chain's own calldata-address encoding — see `ISwapChainAdapter.isAddressEmbeddedInCalldata`).
 */
export function isHexBytesContained(haystack: Hex, needle: Hex): boolean {
    const haystackHex = haystack.toLowerCase().slice(2);
    const needleHex = needle.toLowerCase().slice(2);
    return needleHex.length > 0 && haystackHex.includes(needleHex);
}

/**
 * Asserts the deposit proof calldata appears verbatim inside an aggregator transaction blob,
 * before the quote is proof-bound.
 *
 * @throws {LiFiDepositCalldataNotFound} If the deposit calldata is absent.
 */
export function assertDepositCalldataEmbedded(
    transactionData: Hex,
    depositCallData: Hex,
    chainId: number,
): void {
    if (!isHexBytesContained(transactionData, depositCallData)) {
        throw new LiFiDepositCalldataNotFound(chainId);
    }
}
