import type { RelayerCaps, RelayerChainDetails } from "../internal.js";

/**
 * Reads the per-chain native-wei ceilings a relayer publishes on `/v1/details`
 * (`max_swap_value_wei`) as bigints, so a caller can size or refuse a
 * request before proving instead of meeting the relayer's HTTP 400. A cap the relayer does not
 * publish (older relayer) is left undefined: unknown, not unlimited.
 */
export function relayerCapsFromDetails(
    details: Pick<RelayerChainDetails<unknown>, "maxSwapValueWei">,
): RelayerCaps {
    return {
        maxSwapValueWei: details.maxSwapValueWei !== undefined ? BigInt(details.maxSwapValueWei) : undefined,
    };
}
