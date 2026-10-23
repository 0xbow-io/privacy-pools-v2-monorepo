import { Module } from "@nestjs/common";
import { ReportModule } from "../report/report.module";
import { TelegramConfigService } from "./telegram-config.service";
import { TelegramWebhookController } from "./telegram-webhook.controller";

@Module({
    imports: [ReportModule.forRoot()],
    controllers: [TelegramWebhookController],
    providers: [TelegramConfigService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class TelegramModule {}
