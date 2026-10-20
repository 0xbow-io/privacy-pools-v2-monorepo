import { BadRequestException, DynamicModule, Module, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { Request } from "express";
import { ChainType } from "../config/enums";
import { DetailsController } from "./details.controller";
import { EvmDetailsService } from "./evm.details.service";
import { StellarDetailsService } from "./stellar.details.service";
import { DETAILS_SERVICE, type IDetailsService } from "./details.interface";

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class DetailsModule {
    static forRoot(): DynamicModule {
        return {
            module: DetailsModule,
            controllers: [DetailsController],
            providers: [
                EvmDetailsService,
                StellarDetailsService,
                {
                    provide: DETAILS_SERVICE,
                    scope: Scope.REQUEST,
                    useFactory: (
                        request: Request,
                        evmService: EvmDetailsService,
                        stellarService: StellarDetailsService
                    ): IDetailsService => {
                        const chainType = request.params.chainType;
                        if (!chainType) {
                            // GET /details — no chain type in route, return evm service for allDetails()
                            return evmService;
                        }
                        switch (chainType as ChainType) {
                            case ChainType.EVM:
                                return evmService;
                            case ChainType.STELLAR:
                                return stellarService;
                            default:
                                throw new BadRequestException(`Unsupported chain type: ${chainType}`);
                        }
                    },
                    inject: [REQUEST, EvmDetailsService, StellarDetailsService],
                },
            ],
        };
    }
}
