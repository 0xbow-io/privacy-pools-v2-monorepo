import { ApiProperty } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { zAssetConfig, zChainConfig, zChainContracts, zFullConfig, zYieldWrapper } from "../details/details.schemas";
import type { IAssetConfig, IChainConfig, IChainContracts, IFullConfig, IYieldWrapper } from "../relayer.types";
import type { EvmAddress, EvmChainId } from "../config/evm/evm.types";
import type { ChainType } from "../config/enums";
import type { BPS, Wei } from "../quote/evm/unit.types";

export class AssetConfigDto extends createZodDto(zAssetConfig) implements IAssetConfig {
    @ApiProperty({
        description: "Token contract address",
        type: "string",
        example: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    })
    declare address: EvmAddress;

    @ApiProperty({
        description: "Token ticker symbol",
        example: "USDT",
    })
    declare ticker: string;

    @ApiProperty({
        description: "Chain-level fixed fee amount in wei, always present",
        type: "string",
        example: "1000",
    })
    declare fixedFeeAmount: Wei;

    @ApiProperty({
        description: "Asset-level fee in basis points, present when the asset has a BPS fee configured",
        type: "string",
        required: false,
        example: "42",
    })
    declare feeBPS?: BPS;
}

export class ChainContractsDto extends createZodDto(zChainContracts) implements IChainContracts {
    @ApiProperty({
        description: "Entrypoint contract address (deposits, asset config)",
        type: "string",
        example: "0xe7fd6c857639E3a7cCf3Cd765B5816Cfc95C0890",
    })
    declare entrypoint: EvmAddress;

    @ApiProperty({
        description: "PoolVault contract address (the privacy pool)",
        type: "string",
        example: "0xE10c77548c31356805597Fc2c8430aB5b6Dfb56A",
    })
    declare poolVault: EvmAddress;

    @ApiProperty({
        description:
            "PrivacyPoolRelay contract address — also the EIP-712 verifyingContract for relayer fee commitments",
        type: "string",
        example: "0x6996F478DF754Dc65bB437dc2df4272AFD647dB2",
    })
    declare relay: EvmAddress;

    @ApiProperty({
        description: "RelaySwaps contract address, present only when this chain supports swaps",
        type: "string",
        required: false,
        example: "0x7430cc030d7eb8c83e76cd983996982c8c054204",
    })
    declare relaySwaps?: EvmAddress;
}

export class YieldWrapperDto extends createZodDto(zYieldWrapper) implements IYieldWrapper {
    @ApiProperty({ description: "Yield share token (the shielded asset, ERC-4626 over an Aave aToken)", type: "string" })
    declare ppToken: EvmAddress;

    @ApiProperty({ description: "Underlying ERC-20 the user deposits and receives", type: "string" })
    declare underlying: EvmAddress;

    @ApiProperty({
        description:
            "PPRouter — the `transact` processor to bind into a relayed yield withdrawal proof (routes to withdrawToUnderlying)",
        type: "string",
    })
    declare router: EvmAddress;

    @ApiProperty({ description: "PPYieldTokenZap — stateless share<->underlying helper (loose-share exits, RelaySwaps unwrap)", type: "string" })
    declare zap: EvmAddress;

    @ApiProperty({ description: "Decimals of the share token", type: "number", example: 18 })
    declare ppDecimals: number;

    @ApiProperty({ description: "Decimals of the underlying token", type: "number", example: 6 })
    declare underlyingDecimals: number;

    @ApiProperty({ description: "Symbol of the underlying token", type: "string", example: "USDC" })
    declare underlyingSymbol: string;
}

export class ChainConfigDto extends createZodDto(zChainConfig) implements IChainConfig {
    @ApiProperty({
        description: "Chain ID",
        type: "number",
        example: 11155111,
    })
    declare id: EvmChainId;

    @ApiProperty({
        description: "Human-readable chain name",
        example: "sepolia",
    })
    declare name: string;

    @ApiProperty({
        description: "Chain type",
        example: "evm",
    })
    declare type: ChainType;

    @ApiProperty({
        description: "Contract addresses of the Privacy Pools deployment this relayer serves on this chain",
        type: ChainContractsDto,
    })
    declare contracts: ChainContractsDto;

    @ApiProperty({
        description: "Whether this chain supports relayed swaps (a RelaySwaps contract is configured)",
        type: "boolean",
        example: true,
    })
    declare swapsSupported: boolean;

    @ApiProperty({
        description:
            "Whether a cross-chain reshield may end on this chain: a bridge can run the destination deposit call here (LI.FI receivers deployed)",
        type: "boolean",
        example: true,
    })
    declare destinationCallsSupported: boolean;

    @ApiProperty({
        description: "Supported assets on this chain",
        type: [AssetConfigDto],
    })
    declare assets: AssetConfigDto[];

    @ApiProperty({
        description: "The relayer's signer address on this chain — msg.sender of every relay (RelayerInfo.address)",
        type: "string",
    })
    declare relayerAddress: EvmAddress;

    @ApiProperty({
        description: "Every alternate `transact` processor a relay request may name via processorAddress (allowed_processors)",
        type: [String],
    })
    declare processors: EvmAddress[];

    @ApiProperty({
        description: "Yield wrappers derived on-chain from the allowlisted PPRouters at boot; empty when the chain has none",
        type: [YieldWrapperDto],
    })
    declare yield: YieldWrapperDto[];

    @ApiProperty({
        description:
            "B2 ceiling (this chain's native wei) on a swap quote's swapValue — the LayerZero fee RelaySwaps mints in-contract on a Mainnet-destination reshield (max_swap_value_wei). Requests above it are rejected.",
        type: "string",
        example: "5000000000000000",
    })
    declare maxSwapValueWei: Wei;
}

export class FullConfigDto extends createZodDto(zFullConfig) implements IFullConfig {
    @ApiProperty({
        description: "Relayer build version (package.json version of the deployed relayer)",
        example: "1.0.0",
    })
    declare version: string;

    @ApiProperty({
        description: "All supported chains and their assets",
        type: [ChainConfigDto],
    })
    declare chains: ChainConfigDto[];
}
