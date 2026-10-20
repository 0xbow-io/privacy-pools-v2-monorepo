import type { DustAssetUsdRate } from "../jobs/job.types";

const FIXED_POINT_SCALE = 10n ** 18n;

/**
 * Pure arithmetic — no RPC call, no RateProviderService. All the provider-specific
 * decimal normalization already happened once, on the relayer side, when `usdRate` was
 * computed (see rate_provider/usd_pricing.ts and job.types.ts's `DustAssetUsdRate` doc
 * comment). This is deliberately the only formula this package needs to know.
 */
export function sweptAmountUsdMicros(sweptAmount: bigint, usdRate: DustAssetUsdRate): bigint {
    const rate = BigInt(usdRate.microUsdPerWholeTokenX1e18);
    const scale = 10n ** BigInt(usdRate.tokenDecimals) * FIXED_POINT_SCALE;
    return (sweptAmount * rate) / scale;
}
