import { BadRequestException } from "@nestjs/common";

import { FATLoggerService } from "../../logger/fat.logger.provider";
import { add, applyBPS, BPS, Gas, Wei } from "./unit.types";

interface NativeQuote {
    num: bigint;
    den: bigint;
}

// Where an unrelayable-asset rejection is reported. The operator alert is keyed per chain.
export interface FeeAlertContext {
    logger: FATLoggerService;
    chainId: number;
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
function capFee(feeAmount: Wei, maxRelayFee: Wei, relayCost: Wei, alert: FeeAlertContext): Wei {
    if (maxRelayFee === 0n) return feeAmount; // uncapped — never floor to 0
    if (maxRelayFee < relayCost) {
        const error = `Asset not relayable: maxRelayFee (${maxRelayFee}) is below the relay cost (${relayCost}).`;
        // Operator-config fault (CLAUDE.md §4b): page once per chain.
        alert.logger.error(error, { alert: true, dedupKey: `quote.notRelayable.${alert.chainId}` });
        throw new BadRequestException(error);
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
    tokenDecimals: number,
    alert: FeeAlertContext
): Wei {
    const relayCost = nativeToToken(relayPrice, nativeQuote, tokenDecimals);
    const bpsFee = applyBPS(baseBps, desiredInput);
    const feeDesiredInput = capFee(add(relayCost, bpsFee), maxRelayFee, relayCost, alert);
    return feeDesiredInput;
}

export function calculateExactBpsFee(
    desiredOutput: Wei,
    baseBps: BPS,
    nativeQuote: NativeQuote,
    relayPrice: Wei,
    maxRelayFee: Wei,
    tokenDecimals: number,
    alert: FeeAlertContext
): { feeAmount: Wei; requiredInput: Wei } {
    const relayCost = nativeToToken(relayPrice, nativeQuote, tokenDecimals);
    const bpsFee = applyBPS(baseBps, desiredOutput);
    const feeAmount = capFee(add(relayCost, bpsFee), maxRelayFee, relayCost, alert);
    const requiredInput = add(desiredOutput, feeAmount);
    return { feeAmount, requiredInput };
}

export function calculateFlatFee(relayCost: Wei, flatFeeAmount: bigint, maxRelayFee: Wei, alert: FeeAlertContext): Wei {
    const calculatedFeeAmount = Wei(relayCost + flatFeeAmount);
    return capFee(calculatedFeeAmount, maxRelayFee, relayCost, alert);
}

export function calculateExactFlatFee(desiredOutput: Wei, feeAmount: Wei): Wei {
    return add(desiredOutput, feeAmount);
}

export function calculateExtraGas(extraGasAmount: Gas, nativeQuote: NativeQuote, gasPrice: Wei, tokenDecimals: number): {nativeGas: Wei, nativeGasInToken: Wei} {
    const nativeGas = Wei(extraGasAmount * gasPrice);
    const nativeGasInToken = nativeToToken(nativeGas, nativeQuote, tokenDecimals);
    return {nativeGas, nativeGasInToken};
}
