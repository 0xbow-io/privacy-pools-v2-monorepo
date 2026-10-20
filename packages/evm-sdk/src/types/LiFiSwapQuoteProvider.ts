import type { ILogger } from "@privacy-pools-v2/core-sdk";

// NOTE (evm-sdk split): core-sdk's types/SwapQuoteProvider.ts dropped these two types — they are
// construction config for the concrete (EVM/LiFi-only) LiFiSwapQuoteProvider class, so they live
// here alongside it instead. See the NOTE in core-sdk's own SwapQuoteProvider.ts.

/**
 * Configuration for the LiFi swap quote provider.
 */
export interface LiFiSwapQuoteProviderConfig {
    /** Integrator identifier sent with LiFi API requests. */
    integrator?: string;
    /** Fee percentage to include in LiFi quotes. */
    fee?: number;
    /** LiFi API base URL. Defaults to "https://li.quest/v1". */
    apiUrl?: string;
    /** LiFi API key for authenticated access. */
    apiKey?: string;
    /**
     * Bridges LiFi may use for a CROSS-CHAIN quote (LiFi bridge keys, e.g.
     * `["across"]`). Unset lets LiFi choose. Same-chain quotes are never
     * restricted. Use it to keep routes off a bridge whose extra native fee the
     * flow does not fund (Stargate's LayerZero fee on a native-token input).
     */
    allowBridges?: string[];
}

/**
 * Optional dependencies for the LiFi swap quote provider.
 */
export interface LiFiSwapQuoteProviderDependencies {
    logger?: ILogger;
}
