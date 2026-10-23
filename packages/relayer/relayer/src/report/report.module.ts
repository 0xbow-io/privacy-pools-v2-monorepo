import { BadRequestException, DynamicModule, Module, Scope } from "@nestjs/common";
import { REQUEST, ModuleRef, ContextIdFactory } from "@nestjs/core";
import { ChainType } from "../config/enums";
import { REPORT_SERVICE, type IReportService } from "./report.interface";
import { EvmReportService } from "./evm/evm.report.service";
import { StellarReportService } from "./stellar/stellar.report.service";
import { StarknetReportService } from "./starknet/starknet.report.service";
import { ReportsService } from "./reports.service";

export type ContextId = ReturnType<typeof ContextIdFactory.create>;

/**
 * The only shape `CHAIN_CONTEXT`'s factory (core/core.module.ts) ever reads off `request`, plus the
 * `contextId` `ReportsService` resolved this service under. Carrying `contextId` on the payload
 * itself (rather than recovering it via `ContextIdFactory.getByRequest(request)`, the way
 * `RELAY_SERVICE`/`QUOTE_SERVICE`'s factories do) is deliberate: `getByRequest` only recovers a
 * cached id from a request Nest's own router already tagged on the way in — a synthesized,
 * non-HTTP "request" like this one was never tagged, so `getByRequest` would silently mint a
 * *different* id than the one `moduleRef.resolve(REPORT_SERVICE, contextId, ...)` was called with,
 * and every nested request-scoped resolution (starting with `CHAIN_CONTEXT`) would fall through to
 * an unregistered context. Reading `request.contextId` directly sidesteps that entirely.
 */
export interface FakeChainRequest {
    params: { chainType: ChainType; chainId: string };
    contextId: ContextId;
}

/**
 * Same per-chain-type resolution pattern as `RelayModule`/`QuoteModule`'s `RELAY_SERVICE` /
 * `QUOTE_SERVICE`: a request-scoped factory switching on `ChainType`, resolved lazily via
 * `ModuleRef` so only the chain type actually requested gets constructed (see the matching comment
 * on `RELAY_SERVICE`'s factory in relay.module.ts for why — unconditionally injecting all three
 * chain services would construct all three, and their ConfigServices, regardless of chainType).
 */
@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ReportModule {
    static forRoot(): DynamicModule {
        return {
            module: ReportModule,
            providers: [
                EvmReportService,
                StellarReportService,
                StarknetReportService,
                ReportsService,
                {
                    provide: REPORT_SERVICE,
                    scope: Scope.REQUEST,
                    useFactory: (request: FakeChainRequest, moduleRef: ModuleRef): Promise<IReportService> => {
                        const { chainType } = request.params;
                        const { contextId } = request;
                        switch (chainType) {
                            case ChainType.EVM:
                                return moduleRef.resolve(EvmReportService, contextId, { strict: false });
                            case ChainType.STELLAR:
                                return moduleRef.resolve(StellarReportService, contextId, { strict: false });
                            case ChainType.STARKNET:
                                return moduleRef.resolve(StarknetReportService, contextId, { strict: false });
                            default:
                                throw new BadRequestException(`Unsupported chain type: ${String(chainType)}`);
                        }
                    },
                    inject: [REQUEST, ModuleRef],
                },
            ],
            exports: [ReportsService],
        };
    }
}
