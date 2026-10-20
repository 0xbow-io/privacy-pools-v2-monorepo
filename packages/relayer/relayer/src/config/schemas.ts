import { z } from "zod";
import { ChainType } from "./enums";
import { zEvmChainConfig } from "./evm/evm.config.schemas";
import { zStellarChainConfig } from "./stellar/stellar.config.schemas";

export const zChainType = z.nativeEnum(ChainType);

// Re-export from common.schemas to maintain backwards compatibility
export { zFeeBps, zWithdrawAmount } from "./common.schemas";

// Chains object with optional chainTypes as keys
export const zChains = z.object({
    [ChainType.EVM]: z.array(zEvmChainConfig).optional(),
    [ChainType.STELLAR]: z.array(zStellarChainConfig).optional(),
    // TODO
    // [ChainType.STARKNET]: z.array(zStarknetChainConfig).optional(),
    // [ChainType.SOLANA]: z.array(zSolanaChainConfig).optional(),
});

// A string that must compile as a JS regular expression (fail at config parse,
// not at the first CORS preflight).
const zRegexPattern = z.string().refine(
    (pattern) => {
        try {
            new RegExp(pattern);
            return true;
        } catch {
            return false;
        }
    },
    { message: "must be a valid regular expression" }
);

// Browser-origin allowlist for the HTTP layer. `origins` are exact matches,
// `origin_patterns` are regex sources (e.g. Vercel preview deployments).
// Both are optional and combined; env vars CORS_ORIGIN / CORS_ORIGIN_PATTERN
// override them (see RelayerConfig.corsOrigins()).
export const zCorsConfig = z
    .object({
        origins: z.array(z.string()).optional(),
        origin_patterns: z.array(zRegexPattern).optional(),
    })
    .strict();

// Configuration schema
export const zConfig = z
    .object({
        chains: zChains,
        cors: zCorsConfig.optional(),
    })
    .strict();
