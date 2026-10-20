import type { Address, Hex } from "../internal.js";
import { LiFiDepositCalldataNotFound, LiFiDepositTargetNotFound } from "../internal.js";

/**
 * Returns true when the raw bytes of `needle` appear verbatim inside `haystack`.
 *
 * Both arguments are hex strings; the `0x` prefix is stripped before comparison.
 * An empty needle (just `0x` or `""`) never matches — there is nothing to confirm.
 *
 * LiFi encodes `contractCalls` fields (`toContractCallData`, `toContractAddress`)
 * by copying them verbatim into the ABI-encoded transaction blob without re-encoding
 * or hashing. This means a hex substring search is sufficient to verify their
 * presence — no knowledge of the outer ABI structure is required.
 */
function hexByteContains(haystack: Hex, needle: Hex): boolean {
    const haystackHex = haystack.toLowerCase().slice(2); // strip 0x
    const needleHex = needle.toLowerCase().slice(2); // strip 0x
    return needleHex.length > 0 && haystackHex.includes(needleHex);
}

/**
 * Returns the ABI encoding of an Ethereum address as a 32-byte hex word (no `0x`).
 *
 * Solidity's `abi.encode(address)` left-pads a 20-byte address with 12 zero bytes,
 * producing a 32-byte (64 hex character) word:
 *
 *   `000000000000000000000000<40-char-address>`
 *
 * This is the form in which LiFi embeds `toContractAddress` inside the ABI-encoded
 * `contractCalls` struct. Checking for this padded form confirms the correct contract
 * is targeted rather than just coincidentally containing the address bytes elsewhere.
 *
 * @example
 *   abiPadAddress("0xAbCd...1234")
 *   → "000000000000000000000000abcd...1234"
 */
function abiPadAddress(address: Address): string {
    // 12 zero bytes (24 hex chars) + 20-byte address (40 hex chars) = 32 bytes (64 hex chars)
    return address.toLowerCase().slice(2).padStart(64, "0");
}

/**
 * Asserts the deposit proof calldata appears verbatim inside the LiFi transaction blob.
 *
 * @throws {LiFiDepositCalldataNotFound} If the deposit calldata is absent.
 */
function assertDepositCalldataIsEmbedded(
    lifiTransactionData: Hex,
    depositCallData: Hex,
    chainId: number,
): void {
    if (!hexByteContains(lifiTransactionData, depositCallData)) {
        throw new LiFiDepositCalldataNotFound(chainId);
    }
}

/**
 * Asserts the deposit target address, ABI-padded to a 32-byte word, appears inside
 * the LiFi transaction blob. This is how LiFi encodes `toContractAddress`.
 *
 * @throws {LiFiDepositTargetNotFound} If the padded address is absent.
 */
function assertDepositTargetIsEmbedded(
    lifiTransactionData: Hex,
    depositTargetAddress: Address,
    chainId: number,
): void {
    // Wrap the padded address as a Hex string so hexByteContains can strip its own 0x.
    const paddedAddress = `0x${abiPadAddress(depositTargetAddress)}` as Hex;
    if (!hexByteContains(lifiTransactionData, paddedAddress)) {
        throw new LiFiDepositTargetNotFound(depositTargetAddress, chainId);
    }
}

/**
 * Asserts that the LiFi `transactionData` blob contains the deposit calldata and
 * Entrypoint address verbatim at the raw byte level, before the quote is proof-bound.
 *
 * Passing this check is necessary but not sufficient for a safe payload — it is one
 * layer in a comprehensive validation suite. The check operates below the ABI layer
 * because Diamond proxies re-encode the outer facet call while preserving the inner
 * `contractCalls` struct bytes verbatim; ABI decoding alone cannot reliably cover
 * that boundary.
 *
 * @param lifiTransactionData - The `transactionData` field from the LiFi quote.
 * @param depositCallData - The `Entrypoint.deposit()` calldata from `PrepareDepositResult`.
 * @param depositTargetAddress - The Entrypoint address from `PrepareDepositResult.to`.
 * @param chainId - Chain ID, included in error messages for diagnostic context.
 *
 * @throws {LiFiDepositCalldataNotFound} If `depositCallData` is not found verbatim.
 * @throws {LiFiDepositTargetNotFound} If `depositTargetAddress` (ABI-padded) is not found.
 */
export function assertDepositEmbeddedInLiFiCalldata(
    lifiTransactionData: Hex,
    depositCallData: Hex,
    depositTargetAddress: Address,
    chainId: number,
): void {
    assertDepositCalldataIsEmbedded(lifiTransactionData, depositCallData, chainId);
    assertDepositTargetIsEmbedded(lifiTransactionData, depositTargetAddress, chainId);
}
