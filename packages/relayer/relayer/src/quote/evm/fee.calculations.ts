import { BadRequestException } from "@nestjs/common";

import { add, applyBPS, BPS, Gas, Wei } from "./unit.types";

interface NativeQuote {
    num: bigint;
    den: bigint;
}

// Cap the fee at the asset's nominal `maxRelayFee`, enforcing that the asset is
// actually relayable. `maxRelayFee` is a NOMINAL ceiling in token base units and
// `0` is the "no maximum" sentinel (Entrypoint asset config; see IEntrypoint.sol
// and MockPool "0 = no maximum") — it must NOT be read as a literal zero ceiling,
// which would floor the fee to 0 and let the relayer perform the swap for free
// (audit H1). A *nonzero* cap below the relayer's own cost makes the asset
// unprofitable to relay, so signing that quote is a guaranteed loss (audit R-H3):
// reject it rather than cap below cost. Because every caller passes
// `feeAmount = relayCost + markup`, the returned value is always >= relayCost once
// these guards pass.
function capFee(feeAmount: Wei, maxRelayFee: Wei, relayCost: Wei): Wei {
    if (maxRelayFee === 0n) return feeAmount; // uncapped — never floor to 0
    if (maxRelayFee < relayCost) {
        throw new BadRequestException(
            `Asset not relayable: maxRelayFee (${maxRelayFee}) is below the relay cost (${relayCost}).`
        );
    }
    return maxRelayFee < feeAmount ? maxRelayFee : feeAmount;
}

// Convert a native (wei) amount into token base units using the oracle rate.
// Shared by every native->token conversion so the decimals/scale correction lives
// in one place. The oracle `num` is the WETH cost of one *whole* token, normalized
// to 18 decimals (Curve convention), so the wei amount must be scaled by
// 10^tokenDecimals to land in the token's base units. The native asset passes a
// short-circuit quote (num = 10^decimals, den = 1) so this stays an exact no-op.
export function nativeToToken(nativeAmount: Wei, nativeQuote: NativeQuote, tokenDecimals: number): Wei {
    return Wei((nativeAmount * nativeQuote.den * 10n ** BigInt(tokenDecimals)) / nativeQuote.num);
}

export function calculateBpsFee(
    desiredInput: Wei,
    baseBps: BPS,
    nativeQuote: NativeQuote,
    relayPrice: Wei,
    maxRelayFee: Wei,
    tokenDecimals: number
): Wei {
    const relayCost = nativeToToken(relayPrice, nativeQuote, tokenDecimals);
    const bpsFee = applyBPS(baseBps, desiredInput);
    const feeDesiredInput = capFee(add(relayCost, bpsFee), maxRelayFee, relayCost);
    return feeDesiredInput;
}

export function calculateExactBpsFee(
    desiredOutput: Wei,
    baseBps: BPS,
    nativeQuote: NativeQuote,
    relayPrice: Wei,
    maxRelayFee: Wei,
    tokenDecimals: number
): { feeAmount: Wei; requiredInput: Wei } {
    const relayCost = nativeToToken(relayPrice, nativeQuote, tokenDecimals);
    const bpsFee = applyBPS(baseBps, desiredOutput);
    const feeAmount = capFee(add(relayCost, bpsFee), maxRelayFee, relayCost);
    const requiredInput = add(desiredOutput, feeAmount);
    return { feeAmount, requiredInput };
}

export function calculateFlatFee(relayCost: Wei, flatFeeAmount: bigint, maxRelayFee: Wei): Wei {
    const calculatedFeeAmount = Wei(relayCost + flatFeeAmount);
    return capFee(calculatedFeeAmount, maxRelayFee, relayCost);
}

export function calculateExactFlatFee(desiredOutput: Wei, feeAmount: Wei): Wei {
    return add(desiredOutput, feeAmount);
}

export function calculateExtraGas(extraGasAmount: Gas, nativeQuote: NativeQuote, gasPrice: Wei, tokenDecimals: number): {nativeGas: Wei, nativeGasInToken: Wei} {
    const nativeGas = Wei(extraGasAmount * gasPrice);
    const nativeGasInToken = nativeToToken(nativeGas, nativeQuote, tokenDecimals);
    return {nativeGas, nativeGasInToken};
}
