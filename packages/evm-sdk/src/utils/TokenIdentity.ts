import type { Address } from "../internal.js";
import { EMPTY_ADDRESS, NATIVE_ASSET_ADDRESS } from "../internal.js";

/**
 * LiFi's spelling of the native coin. Privacy Pools uses `NATIVE_ASSET_ADDRESS`
 * (0xEeee…EEeE) in entrypoint asset config, notes, and RelaySwaps; LiFi uses the
 * zero address. LiFi accepts either on a request but always ECHOES the zero
 * address in `step.action.fromToken/toToken`.
 */
export const LIFI_NATIVE_TOKEN_ADDRESS = EMPTY_ADDRESS as Address;

function isNativeToken(address: string): boolean {
    const lower = address.toLowerCase();
    return (
        lower === NATIVE_ASSET_ADDRESS.toLowerCase() ||
        lower === LIFI_NATIVE_TOKEN_ADDRESS.toLowerCase()
    );
}

/**
 * Rewrites any spelling of the native coin to Privacy Pools' canonical
 * `NATIVE_ASSET_ADDRESS`; every other address passes through unchanged.
 *
 * Applied at the provider boundary (`LiFiSwapQuoteProvider`'s result extractors)
 * so a `SwapQuoteResult` / `SwapAndDepositQuoteResult` never carries LiFi's
 * zero-address spelling of native downstream — every consumer of
 * `fromTokenAddress` / `toTokenAddress`, now and later, sees one canonical form.
 * With this in place the session-level `isSameToken` cross-check (below) is
 * belt-and-suspenders against a hand-built or future non-normalized quote, not
 * the sole fix.
 */
export function canonicalTokenAddress(address: string): Address {
    return isNativeToken(address) ? NATIVE_ASSET_ADDRESS : (address as Address);
}

/**
 * Whether two token addresses denote the same asset: case-insensitive, and
 * treating both spellings of the native coin as one token.
 *
 * Used by the swap sessions to cross-check the route LiFi echoes against the
 * route that was requested. A literal compare there rejected every quote with
 * native on either leg — the request carried 0xEeee…, the echo came back
 * 0x0000… — so ETH-pool exits, receive-as-ETH and ETH-funded swap-deposits all
 * failed with `SwapQuoteMismatch` before any calldata was bound. The check's
 * purpose (never proof-bind a route to the WRONG token) is unchanged: a real
 * ERC20 answered with the zero address, or native answered with some other
 * token, is still a mismatch.
 */
export function isSameToken(a: string, b: string): boolean {
    if (a.toLowerCase() === b.toLowerCase()) return true;
    return isNativeToken(a) && isNativeToken(b);
}
