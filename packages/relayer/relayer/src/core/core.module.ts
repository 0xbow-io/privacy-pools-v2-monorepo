import { Global, Module, Scope } from "@nestjs/common";
import { APP_FILTER, REQUEST } from "@nestjs/core";
import type { Request } from "express";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { StellarConfigService } from "../config/stellar/stellar-config.service";
import { RelayerConfig } from "../config/relayer-config";
import { ChainType } from "../config/enums";
import { EVMChainService } from "../chain.service/evm.chain.service";
import { StellarChainService } from "../chain.service/stellar.chain.service";
import { ZodValidationFilter } from "../filters/zod-validation.filter";
import { RedactingHttpExceptionFilter } from "../filters/redacting-http-exception.filter";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { YieldZapRegistry } from "../rate_provider/yield_zap_registry";
import { YieldDiscoveryService } from "../details/yield-discovery.service";
import { RoutingLayoutBootValidator } from "../relay/evm/routing_layout_boot_validator";
import { StuckNonceReconcilerService } from "../chain.service/stuck-nonce-reconciler.service";
import { ReconcileAuthGuard } from "../chain.service/reconcile-auth.guard";
import { CHAIN_CONTEXT, ChainContext } from "./chain-context.token";

@Global()
@Module({
    providers: [
        FATLoggerService,
        RelayerConfig,
        {
            provide: CHAIN_CONTEXT,
            scope: Scope.REQUEST,
            useFactory: (request: Request): ChainContext => {
                const { chainType, chainId } = request.params;
                return {
                    chainType: chainType as ChainType,
                    chainId: Number(chainId),
                };
            },
            inject: [REQUEST],
        },
        EvmConfigService,
        EVMChainService,
        StellarConfigService,
        StellarChainService,
        YieldZapRegistry,
        YieldDiscoveryService,
        RoutingLayoutBootValidator,
        StuckNonceReconcilerService,
        ReconcileAuthGuard,
        {
            provide: APP_FILTER,
            useClass: ZodValidationFilter,
        },
        {
            provide: APP_FILTER,
            useClass: RedactingHttpExceptionFilter,
        },
    ],
    exports: [
        FATLoggerService,
        RelayerConfig,
        CHAIN_CONTEXT,
        EvmConfigService,
        EVMChainService,
        StellarConfigService,
        StellarChainService,
        YieldZapRegistry,
        YieldDiscoveryService,
        RoutingLayoutBootValidator,
        StuckNonceReconcilerService,
        ReconcileAuthGuard,
    ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class CoreModule {}
