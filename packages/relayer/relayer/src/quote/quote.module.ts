import { BadRequestException, DynamicModule, Module, Scope } from "@nestjs/common";
import { REQUEST, DiscoveryModule, ModuleRef, ContextIdFactory } from "@nestjs/core";
import type { Request } from "express";
import { ChainType } from "../config/enums";
import { QUOTE_SERVICE, type IQuoteService } from "./quote.interface";
import { EvmQuoteService } from "./evm/evm.quote.service";
import { StarknetQuoteService } from "./starknet/starknet.quote.service";
import { StellarQuoteService } from "./stellar/stellar.quote.service";
import { QuoteController } from "./quote.controller";
import { QuoteValidationPipe } from "./quote-validation.pipe";
import { QuoteDeadlineInterceptor } from "./quote-deadline.interceptor";
import { RateProviderModule } from "../rate_provider/rate_provider.module";
import { RateProvider, type RateProviderDescription } from "../rate_provider/rate_types";
import { RateProviderBootValidator } from "../rate_provider/rate_provider_boot_validator";
import { EvmContractService } from "../sdk/evm.contract.service";
import * as curve_parameters from "../rate_provider/curve/curve_quote_obtention";
import * as cowswap_parameters from "../rate_provider/cowswap/quote_obtention";
import * as mock_sepolia_parameters from "../rate_provider/mock_sepolia/mock_sepolia_quote";
import * as uniswap_v3_parameters from "../rate_provider/uniswap_v3/quote_obtention";

// Static JSON imports (resolveJsonModule, enabled in tsconfig.json) rather than a
// __dirname-relative readFileSync. __dirname means something different in every runtime
// that loads this module — the source tree under ts-jest, vs. the single bundled
// dist/main.js webpack produces for the app itself — so no one relative string computed
// from it can resolve correctly in both. A static import is resolved against *this file's*
// own module path at compile/bundle time in both cases, sidestepping the mismatch entirely.
import curveDescriptionJson from "../rate_provider/curve/rate_provider_description.json";
import cowswapDescriptionJson from "../rate_provider/cowswap/rate_provider_description.json";
import mockDescriptionJson from "../rate_provider/mock_sepolia/rate_provider_description.json";
import uniswapV3DescriptionJson from "../rate_provider/uniswap_v3/rate_provider_description.json";

// Get environment variables
import * as dotenv from "dotenv";
import { existsSync } from "fs";

if (existsSync("./.env")) {
    dotenv.config({ path: `./.env` });
}

// JSON-import inference gives each field a plain string type (e.g. provider: string),
// not the RateProvider/ChainType enums RateProviderDescription declares — the enum values
// are string-identical to the JSON literals, so this is a safe assertion, not a real
// structural mismatch.
const curveDescription = curveDescriptionJson as RateProviderDescription;
const cowswapDescription = cowswapDescriptionJson as RateProviderDescription;
const mockDescription = mockDescriptionJson as RateProviderDescription;
const uniswapV3Description = uniswapV3DescriptionJson as RateProviderDescription;

// Mock pricing (hardcoded 1:1) must never be reachable without an explicit opt-in — it
// silently mispriced production fees before (see issue #961). Real providers (Curve,
// CowSwap) are always registered; Mock only joins them when this is explicitly set.
const allowMockRateProvider = process.env.ALLOW_MOCK_RATE_PROVIDER === "true";

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class QuoteModule {
    static forRoot(): DynamicModule {
        return {
            module: QuoteModule,
            imports: [
                DiscoveryModule,
                RateProviderModule.register(RateProvider.CURVE, curve_parameters.queryRate, curveDescription),
                RateProviderModule.register(RateProvider.COWSWAP, cowswap_parameters.queryRate, cowswapDescription),
                RateProviderModule.register(RateProvider.UNISWAP, uniswap_v3_parameters.queryRate, uniswapV3Description),
                // Mock is fail-closed: only registered (and thus only resolvable via an
                // asset's `quoter: "Mock"`) when ALLOW_MOCK_RATE_PROVIDER=true is explicitly
                // set. Without it, an asset configured with quoter "Mock" fails loudly at
                // first quote request instead of silently returning a hardcoded 1:1 rate.
                ...(allowMockRateProvider
                    ? [RateProviderModule.register(RateProvider.MOCK, mock_sepolia_parameters.queryRate, mockDescription)]
                    : []),
            ],
            controllers: [QuoteController],
            providers: [
                EvmContractService,
                EvmQuoteService,
                StarknetQuoteService,
                StellarQuoteService,
                QuoteValidationPipe,
                QuoteDeadlineInterceptor,
                RateProviderBootValidator,
                {
                    provide: QUOTE_SERVICE,
                    scope: Scope.REQUEST,
                    // Resolved lazily via ModuleRef, not injected by class (the previous form)
                    // — NestJS constructs every injected param of a factory before calling it, so
                    // naming all three chain services unconditionally meant every request
                    // constructed EvmQuoteService/StarknetQuoteService/StellarQuoteService
                    // together, regardless of the request's actual chainType. Each of those
                    // eagerly constructs its chain's ConfigService, which throws in ITS
                    // constructor when that chain has no config entry for the requested chainId
                    // — so e.g. a Stellar-only relayer config broke every EVM-typed request (and
                    // vice versa) before this even reached the switch below.
                    // `ContextIdFactory.getByRequest` reuses this request's own durable context,
                    // the same one CHAIN_CONTEXT/EvmConfigService/etc. already resolved against,
                    // so the lazily-resolved service instance is request-scoped as before.
                    useFactory: (request: Request, moduleRef: ModuleRef): Promise<IQuoteService> => {
                        const chainType = request.params.chainType as ChainType;
                        const contextId = ContextIdFactory.getByRequest(request);
                        switch (chainType) {
                            case ChainType.EVM:
                                return moduleRef.resolve(EvmQuoteService, contextId, { strict: false });
                            case ChainType.STARKNET:
                                return moduleRef.resolve(StarknetQuoteService, contextId, { strict: false });
                            case ChainType.STELLAR:
                                return moduleRef.resolve(StellarQuoteService, contextId, { strict: false });
                            default:
                                throw new BadRequestException(`Unsupported chain type: ${chainType}`);
                        }
                    },
                    inject: [REQUEST, ModuleRef],
                },
            ],
            exports: [QUOTE_SERVICE],
        };
    }
}
