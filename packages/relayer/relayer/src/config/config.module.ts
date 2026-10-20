import { Module, Global } from "@nestjs/common";
import { EvmConfigService } from "./evm/evm-config.service";

@Global()
@Module({
    providers: [EvmConfigService],
    exports: [EvmConfigService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ConfigModule {}
