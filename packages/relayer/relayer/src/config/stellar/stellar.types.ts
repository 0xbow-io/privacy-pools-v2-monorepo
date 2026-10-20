import type { StellarAddress } from "@privacy-pools-v2/stellar-sdk";

export type { StellarAddress };

export type StellarChainId = number & { readonly __brand: "StellarChainId" };

export type StellarSecretKey = string & { readonly __brand: "StellarSecretKey" };
