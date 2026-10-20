import { arbitrum, base, sepolia } from "viem/chains";

/** Set of chain IDs supported by the SDK. */
export const SUPPORTED_CHAIN_IDS: ReadonlySet<number> = new Set([sepolia.id, arbitrum.id, base.id]);
