import type { Quote } from "./rate_types";
import { RateProvider } from "./rate_types";

const MICRO_USD_SCALE = 1_000_000n; // 1e-6 USD
const FIXED_POINT_SCALE = 10n ** 18n;

/**
 * Converts a `Quote` (dust asset -> reference stablecoin, from `queryRateForPair`) into
 * a decimals-normalized, provider-agnostic price: micro-USD per ONE WHOLE dust token,
 * scaled by 1e18 for fixed-point precision. See
 * dust_collection_service_detailed_design.org §4b and `jobs/job.types.ts`'s
 * `DustAssetUsdRate` doc comment for the consuming side's arithmetic.
 *
 * Both wired providers return `Quote.num`/`Quote.den` in the shared convention
 * (num/den = whole-output-token per whole-input-token, scaled by 1e18) — Curve's
 * `get_aggregated_rate` natively (both balances normalized to 18 decimals internally per
 * https://docs.curve.finance/developer/integration/rate-provider, den always 1n), and
 * CowSwap normalized at the source in `cowswap/quote_obtention.ts`. So `num/den / 1e18`
 * is directly "whole stablecoin units per whole dust token"; since the reference
 * stablecoin is ~$1-pegged, that's already ~USD, and the target scale is
 * micro-USD per whole token x1e18 = (num/den / 1e18) * 1e6 * 1e18 = num * 1e6 / den.
 *
 * Verified against a shared worked example (1 dust token == 1 whole reference
 * stablecoin): both providers' quote shapes return the same `1e24` for an 18-decimal
 * dust asset priced 1:1 against a 6-decimal stablecoin — see usd_pricing.spec.ts.
 */
export function microUsdPerWholeTokenX1e18(quote: Quote): bigint {
    if (quote.source === RateProvider.CURVE || quote.source === RateProvider.COWSWAP) {
        return (quote.num * MICRO_USD_SCALE) / quote.den;
    }

    throw new Error(
        `microUsdPerWholeTokenX1e18: unsupported rate provider ${quote.source} for USD pricing ` +
            `(only Curve and CowSwap are wired for the dust-rescue worth-it gate).`,
    );
}

/** Convenience for tests / call sites that want the plain USD-per-whole-token float-ish value. */
export function formatMicroUsdPerWholeTokenX1e18(value: bigint): string {
    const micros = value / FIXED_POINT_SCALE;
    return `$${(Number(micros) / 1_000_000).toFixed(6)}`;
}
