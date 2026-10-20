// Enable BigInt JSON serialization globally: every bigint (Wei, Gas, BPS, ...) in a response goes
// out as its DECIMAL string. Clients depend on that encoding — e.g. the SDK reads /details'
// fixedFeeAmount / maxSwapValueWei as decimal strings — so it lives in its own
// module, imported by main.ts and pinned by bigint-json.spec.ts / evm.details.service.spec.ts.
export function installBigIntJson(): void {
    (BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
        return this.toString();
    };
}
