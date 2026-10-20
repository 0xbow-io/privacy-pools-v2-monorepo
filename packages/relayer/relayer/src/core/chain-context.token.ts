import { ChainType } from "../config/enums";

export const CHAIN_CONTEXT = Symbol("CHAIN_CONTEXT");

export interface ChainContext {
    chainType: ChainType;
    chainId: number;
}
