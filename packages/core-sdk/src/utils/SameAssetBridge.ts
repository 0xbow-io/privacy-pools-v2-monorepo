/**
 * Whether a swap quote describes a SAME-ASSET bridge — the same token, in the
 * same units, on two chains — as opposed to a genuine swap between assets.
 *
 * The distinction decides whether an output-denominated amount may be compared
 * with an input-denominated one at all. Bridging 1000 USDC cannot yield more
 * than 1000 USDC once fees are taken, so an output that exceeds the input is a
 * temporarily-favorable LP rate (Across incentives, for one) and must not size
 * a deposit that fails when normal rates return. Between different assets no
 * such relation exists: the two numbers are counts of different things.
 *
 * Addresses cannot answer this. The same asset carries different addresses on
 * different chains — USDC is 0x0b2C…Ff85 on Optimism and 0xA0b8…eB48 on
 * Ethereum — which is exactly the case the comparison is for. Decimals alone
 * cannot either: USDC (6dp) and a different 6dp token are not interchangeable.
 * Symbol AND decimals together, as the provider routed them, are the available
 * evidence.
 *
 * Unproven is not the same as false: a provider that reports no symbol yields
 * `false` here, and the caller must treat that as "no comparison is licensed",
 * never as "the assets differ".
 */
export function isSameAssetBridgeQuote(quote: {
    fromTokenSymbol?: string;
    toTokenSymbol?: string;
    fromTokenDecimals?: number;
    toTokenDecimals?: number;
}): boolean {
    const from = quote.fromTokenSymbol;
    const to = quote.toTokenSymbol;
    if (typeof from !== "string" || typeof to !== "string") return false;
    if (from.length === 0 || from.toUpperCase() !== to.toUpperCase()) return false;
    const fromDecimals = quote.fromTokenDecimals;
    const toDecimals = quote.toTokenDecimals;
    if (!Number.isInteger(fromDecimals) || !Number.isInteger(toDecimals)) return false;
    return fromDecimals === toDecimals;
}

/**
 * Ceiling for the output amount a cross-chain deposit is sized from.
 *
 * Applies the same-asset bridge ceiling described in
 * {@link isSameAssetBridgeQuote} and otherwise returns the output untouched —
 * matching the same-chain reshield path, which has never applied a ceiling.
 *
 * @param estimatedMinOutput - The quote's minimum output, in OUTPUT-token units.
 * @param netSwapAmount - The input available after the relayer fee, in INPUT-token units.
 * @param quote - The quote's routed-token metadata.
 * @returns The bounded amount, in OUTPUT-token units.
 */
export function capBridgeOutputToInput(
    estimatedMinOutput: bigint,
    netSwapAmount: bigint,
    quote: {
        fromTokenSymbol?: string;
        toTokenSymbol?: string;
        fromTokenDecimals?: number;
        toTokenDecimals?: number;
    },
): bigint {
    if (!isSameAssetBridgeQuote(quote)) return estimatedMinOutput;
    return estimatedMinOutput > netSwapAmount ? netSwapAmount : estimatedMinOutput;
}
