import { Address } from "viem";

export type EvmAddress = Address;

export type EvmPrivateKey = `0x${string}`;

export type EvmChainId = number & { readonly __brand: "ChainId" };

// Sentinel address chain configs use to mark the chain's native asset
// (ETH on mainnet/sepolia, cBTC on Citrea, ...). Lowercased for comparison
// against user/config input of any casing.
export const NATIVE_ASSET_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
