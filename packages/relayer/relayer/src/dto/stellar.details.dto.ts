import { ApiProperty } from "@nestjs/swagger";
import type {
    IStellarAssetConfig,
    IStellarChainConfig,
    IStellarChainContracts,
    IStellarFullConfig,
} from "../details/details.interface";
import type { StellarAddress } from "../config/types";
import { ChainType } from "../config/enums";

export class StellarAssetConfigDto implements IStellarAssetConfig {
    @ApiProperty({ description: "Token contract StrKey address", type: "string" })
    declare address: StellarAddress;

    @ApiProperty({ description: "Token ticker symbol", example: "USDC" })
    declare ticker: string;

    @ApiProperty({ description: "Chain-level fixed fee amount in stroops, always present", type: "string" })
    declare fixedFeeAmount: bigint;

    @ApiProperty({
        description: "Asset-level fee in basis points, present when the asset has a BPS fee configured",
        required: false,
    })
    declare feeBPS?: number;
}

export class StellarChainContractsDto implements IStellarChainContracts {
    @ApiProperty({ description: "Pool contract StrKey address (deposits, asset config, transact)", type: "string" })
    declare pool: StellarAddress;

    @ApiProperty({ description: "Relay contract StrKey address", type: "string" })
    declare relay: StellarAddress;

    @ApiProperty({ description: "Keystore contract StrKey address", type: "string" })
    declare keystore: StellarAddress;

    @ApiProperty({ description: "ASP registry contract StrKey address", type: "string" })
    declare aspRegistry: StellarAddress;
}

export class StellarChainConfigDto implements IStellarChainConfig {
    @ApiProperty({ description: "Chain ID (relayer-internal — Stellar has no native chainId)", type: "number" })
    declare id: number;

    @ApiProperty({ description: "Human-readable chain name", example: "stellar-testnet" })
    declare name: string;

    @ApiProperty({ description: "Chain type", example: "stellar" })
    declare type: ChainType.STELLAR;

    @ApiProperty({ description: "Contract addresses of the Privacy Pools deployment this relayer serves", type: StellarChainContractsDto })
    declare contracts: StellarChainContractsDto;

    @ApiProperty({ description: "Supported assets on this chain", type: [StellarAssetConfigDto] })
    declare assets: StellarAssetConfigDto[];

    @ApiProperty({ description: "The relayer's signer address on this chain — the `relayer` of every relay()", type: "string" })
    declare relayerAddress: StellarAddress;
}

export class StellarFullConfigDto implements IStellarFullConfig {
    @ApiProperty({ description: "Relayer build version", example: "1.0.0" })
    declare version: string;

    @ApiProperty({ description: "All supported Stellar chains and their assets", type: [StellarChainConfigDto] })
    declare chains: StellarChainConfigDto[];
}
