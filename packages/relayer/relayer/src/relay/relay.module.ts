import { BadRequestException, DynamicModule, Module, Scope } from "@nestjs/common";
import { REQUEST, ModuleRef, ContextIdFactory } from "@nestjs/core";
import type { Request } from "express";
import { ChainType } from "../config/enums";
import { RELAY_SERVICE, type IRelayService } from "./relay.interface";
import { EvmRelayService } from "./evm/evm.relay.service";
import { StarknetRelayService } from "./starknet/starknet.relay.service";
import { StellarRelayService } from "./stellar/stellar.relay.service";
import { RelayController } from "./relay.controller";
import { EvmContractService } from "../sdk/evm.contract.service";
import { DustRescueOrchestratorService } from "./evm/dust-rescue-orchestrator.service";
import { DustRescuePricingService } from "./evm/dust-rescue-pricing.service";
import { DustRescueForwardingService } from "./evm/dust-rescue-forwarding.service";

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class RelayModule {
    static forRoot(): DynamicModule {
        return {
            module: RelayModule,
            controllers: [RelayController],
            providers: [
                EvmContractService,
                EvmRelayService,
                StarknetRelayService,
                StellarRelayService,
                DustRescueOrchestratorService,
                DustRescuePricingService,
                DustRescueForwardingService,
                {
                    provide: RELAY_SERVICE,
                    scope: Scope.REQUEST,
                    // Resolved lazily via ModuleRef — see the matching comment on QUOTE_SERVICE's
                    // factory in quote.module.ts for why: injecting all three chain services by
                    // class unconditionally constructed all three (and their ConfigServices) for
                    // every request regardless of chainType, so a relayer config missing one
                    // chain's entry for the requested chainId broke every OTHER chain's requests
                    // too.
                    useFactory: (request: Request, moduleRef: ModuleRef): Promise<IRelayService> => {
                        const chainType = request.params.chainType as ChainType;
                        const contextId = ContextIdFactory.getByRequest(request);
                        switch (chainType) {
                            case ChainType.EVM:
                                return moduleRef.resolve(EvmRelayService, contextId, { strict: false });
                            case ChainType.STARKNET:
                                return moduleRef.resolve(StarknetRelayService, contextId, { strict: false });
                            case ChainType.STELLAR:
                                return moduleRef.resolve(StellarRelayService, contextId, { strict: false });
                            default:
                                throw new BadRequestException(`Unsupported chain type: ${chainType}`);
                        }
                    },
                    inject: [REQUEST, ModuleRef],
                },
            ],
            exports: [RELAY_SERVICE],
        };
    }
}
