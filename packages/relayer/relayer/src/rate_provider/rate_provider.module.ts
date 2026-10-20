import { Module, DynamicModule } from "@nestjs/common";
import { RateProviderService } from "./rate_provider.service";
import type { RateProvider, RateGetterFunction, RateProviderDescription } from "./rate_types";

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class RateProviderModule {
    static register(
        token: RateProvider,
        get_rate: RateGetterFunction,
        description: RateProviderDescription
    ): DynamicModule {
        return {
            module: RateProviderModule,
            providers: [
                {
                    provide: token,
                    useClass: RateProviderService,
                },
                {
                    provide: "RATE_GETTER_FUNCTION",
                    useValue: get_rate,
                },
                {
                    provide: "RATE_PROVIDER_DESCRIPTION",
                    useValue: description,
                },
            ],
            exports: [token],
        };
    }
}
