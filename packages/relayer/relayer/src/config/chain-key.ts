import { ChainType } from "./enums";

// Chain-type-namespaced key for any module-level cache or in-memory state
// indexed by a per-chain numeric id, and for the matching env-var override
// suffix.
// This Relayer is hard multi chaintype and multi chain, so we need to identify
// boths classifications every time we mention a chain or asset.
export type ChainKey = string & { readonly __brand: "ChainKey" };

export function chainKey(chainType: ChainType, id: number): ChainKey {
    return `${chainType.toUpperCase()}_${id}` as ChainKey;
}
