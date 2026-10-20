import { constants } from "starknet";

export const StarknetChainId = {
    Starknet: constants.StarknetChainId.SN_MAIN,
    Sepolia: constants.StarknetChainId.SN_SEPOLIA,
} as const;

export type StarknetChainId = (typeof StarknetChainId)[keyof typeof StarknetChainId];

// TODO: Define proper Starknet quote response fields
export interface StarknetQuoteResponse {
    something: bigint;
    // Placeholder - implement when Starknet is supported
}
