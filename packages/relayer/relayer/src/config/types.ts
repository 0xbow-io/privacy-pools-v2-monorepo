import { z } from "zod";
import { zEvmAssetConfig, zEvmChainConfig } from "./evm/evm.config.schemas";
import { zStellarAssetConfig, zStellarChainConfig } from "./stellar/stellar.config.schemas";
import { zChains, zConfig, zCorsConfig } from "./schemas";

// Re-export ChainType enum
export { ChainType } from "./enums";

// Re-export EVM types
export type { EvmAddress, EvmPrivateKey, EvmChainId } from "./evm/evm.types";

// Re-export Stellar types
export type { StellarAddress, StellarChainId, StellarSecretKey } from "./stellar/stellar.types";

//===//   Export types derived from Zod schemas   //===//
// Config and asset config for different chains
export type EvmAssetConfig = z.infer<typeof zEvmAssetConfig>;
export type EvmChainConfig = z.infer<typeof zEvmChainConfig>;
export type StellarAssetConfig = z.infer<typeof zStellarAssetConfig>;
export type StellarChainConfig = z.infer<typeof zStellarChainConfig>;
// export type StarknetAssetConfig = z.infer<typeof zStarknetAssetConfig>;
// export type StarknetChainConfig = z.infer<typeof zStarknetChainConfig>;
// export type SolanaAssetConfig = z.infer<typeof zSolanaAssetConfig>;
// export type SolanaChainConfig = z.infer<typeof zSolanaChainConfig>;

// Config type
export type Config = z.infer<typeof zConfig>;

// CORS section type
export type CorsConfig = z.infer<typeof zCorsConfig>;

// Chains type
export type Chains = z.infer<typeof zChains>;

// Union of all chain config types
export type ChainConfig = EvmChainConfig | StellarChainConfig; // | StarknetChainConfig | SolanaChainConfig

// export type SafeChainConfig = z.infer<typeof zSafeChainConfig>;
// export type SafeConfig = Omit<Config, "chains"> & {
//   chains: SafeChainConfig[];
// };
