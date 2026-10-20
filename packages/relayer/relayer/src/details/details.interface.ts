import { ChainType } from "../config/enums";
import type { IAssetConfig, IChainConfig, IFullConfig } from "../relayer.types";
import type { StellarAddress } from "../config/types";

export interface EvmDetailsTypes {
    fullConfig: IFullConfig;
    chainConfig: IChainConfig;
    assetConfig: IAssetConfig;
}

// Stellar's own detail types — not in relayer.types.ts, which is EVM's own file (see the
// chain-agnosticity refactor). Deliberately simpler topology than EVM's: one pool contract
// (no separate entrypoint), no swaps, no yield subsystem, no alternate processors.
export interface IStellarChainContracts {
    pool: StellarAddress;
    relay: StellarAddress;
    keystore: StellarAddress;
    aspRegistry: StellarAddress;
}

export interface IStellarAssetConfig {
    address: StellarAddress;
    ticker: string;
    fixedFeeAmount: bigint;
    feeBPS?: number;
}

export interface IStellarChainConfig {
    id: number;
    name: string;
    type: ChainType.STELLAR;
    contracts: IStellarChainContracts;
    assets: IStellarAssetConfig[];
    relayerAddress: StellarAddress;
}

export interface IStellarFullConfig {
    version: string;
    chains: IStellarChainConfig[];
}

export interface StellarDetailsTypes {
    fullConfig: IStellarFullConfig;
    chainConfig: IStellarChainConfig;
    assetConfig: IStellarAssetConfig;
}

export interface DetailsTypes {
    [ChainType.EVM]: EvmDetailsTypes;
    [ChainType.STARKNET]: never;
    [ChainType.SOLANA]: never; // TODO: replace when Solana is implemented
    [ChainType.STELLAR]: StellarDetailsTypes;
}

export interface IDetailsService<T extends DetailsTypes[ChainType] = DetailsTypes[ChainType]> {
    allDetails(): Promise<T["fullConfig"]>;
    chainDetails(chainId: number): Promise<T["chainConfig"]>;
    assetDetails(chainId: number, asset: string): Promise<T["assetConfig"]>;
}

export type ChainedDetailsService<TChainType extends ChainType> = IDetailsService<DetailsTypes[TChainType]>;

export const DETAILS_SERVICE = Symbol("DETAILS_SERVICE");
