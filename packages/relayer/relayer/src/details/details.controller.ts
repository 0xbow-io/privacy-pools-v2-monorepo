import { BadRequestException, Controller, Get, Inject, Param } from "@nestjs/common";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { ApiExtraModels, ApiOkResponse, ApiOperation, getSchemaPath } from "@nestjs/swagger";
import { ChainType } from "../config/enums";
import { zEvmAddress, zEvmChainId } from "../config/evm/evm.config.schemas";
import { zStellarAddress, zStellarChainId } from "../config/stellar/stellar.config.schemas";
import { AssetConfigDto, ChainConfigDto, FullConfigDto } from "../dto/evm.details.dto";
import {
    StellarAssetConfigDto,
    StellarChainConfigDto,
    StellarFullConfigDto,
} from "../dto/stellar.details.dto";
import { DETAILS_SERVICE, type IDetailsService } from "./details.interface";

@ApiExtraModels(
    ChainConfigDto,
    AssetConfigDto,
    FullConfigDto,
    StellarChainConfigDto,
    StellarAssetConfigDto,
    StellarFullConfigDto
)
@Controller("details")
export class DetailsController {
    constructor(
        @Inject(DETAILS_SERVICE) private readonly detailsService: IDetailsService,
        private readonly logger: FATLoggerService
    ) {}

    @Get()
    @ApiOperation({ summary: "Get asset config for all supported chains" })
    @ApiOkResponse({ type: FullConfigDto })
    async getAllDetails(): Promise<FullConfigDto> {
        this.logger.info("Details endpoint called");
        // DETAILS_SERVICE's factory always resolves EvmDetailsService for the chainless route
        // (details.module.ts) — the union return type only exists because IDetailsService is
        // generic over every chain type now that Stellar is real; this route specifically is
        // EVM-only by routing, not by an unchecked assumption.
        return this.detailsService.allDetails() as Promise<FullConfigDto>;
    }

    @Get(":chainType")
    @ApiOperation({ summary: "Get asset config for all chains of a chain type" })
    @ApiOkResponse({ schema: { oneOf: [{ $ref: getSchemaPath(FullConfigDto) }, { $ref: getSchemaPath(StellarFullConfigDto) }] } })
    async getChainTypeDetails(@Param("chainType") chainType: string): Promise<FullConfigDto | StellarFullConfigDto> {
        this.logger.info("Chain-type details endpoint called", { chainType });
        if (chainType !== ChainType.EVM && chainType !== ChainType.STELLAR) {
            throw new BadRequestException(`Unsupported chain type: ${chainType}`);
        }
        // The DETAILS_SERVICE factory already resolved the per-type service from
        // request.params.chainType (details.module.ts), so allDetails() reports this type only.
        return this.detailsService.allDetails();
    }

    @Get(":chainType/:chainId")
    @ApiOperation({ summary: "Get asset details for a specific chain" })
    @ApiOkResponse({ schema: { oneOf: [{ $ref: getSchemaPath(ChainConfigDto) }, { $ref: getSchemaPath(StellarChainConfigDto) }] } })
    async getChainDetails(
        @Param("chainType") chainType: string,
        @Param("chainId") rawChainId: string
    ): Promise<ChainConfigDto | StellarChainConfigDto> {
        this.logger.info("Chain details endpoint called", { chainType, chainId: rawChainId });
        if (chainType === ChainType.EVM) {
            const chainId = zEvmChainId.parse(rawChainId);
            return this.detailsService.chainDetails(chainId);
        }
        if (chainType === ChainType.STELLAR) {
            const chainId = zStellarChainId.parse(rawChainId);
            return this.detailsService.chainDetails(chainId);
        }
        throw new BadRequestException(`Unsupported chain type: ${chainType}`);
    }

    @Get(":chainType/:chainId/:asset")
    @ApiOperation({ summary: "Get details for a specific asset on a chain" })
    @ApiOkResponse({ schema: { oneOf: [{ $ref: getSchemaPath(AssetConfigDto) }, { $ref: getSchemaPath(StellarAssetConfigDto) }] } })
    async getAssetDetails(
        @Param("chainType") chainType: string,
        @Param("chainId") rawChainId: string,
        @Param("asset") rawAsset: string
    ): Promise<AssetConfigDto | StellarAssetConfigDto> {
        this.logger.info("Asset details endpoint called", { chainType, chainId: rawChainId, asset: rawAsset });
        if (chainType === ChainType.EVM) {
            const chainId = zEvmChainId.parse(rawChainId);
            const asset = zEvmAddress.parse(rawAsset);
            return this.detailsService.assetDetails(chainId, asset);
        }
        if (chainType === ChainType.STELLAR) {
            const chainId = zStellarChainId.parse(rawChainId);
            const asset = zStellarAddress.parse(rawAsset);
            return this.detailsService.assetDetails(chainId, asset);
        }
        throw new BadRequestException(`Unsupported chain type: ${chainType}`);
    }
}
