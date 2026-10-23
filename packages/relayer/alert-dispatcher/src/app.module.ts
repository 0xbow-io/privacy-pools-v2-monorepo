import { Module } from "@nestjs/common";
import { AlertDispatcherConfigService } from "./config/alert-dispatcher-config.service";
import { FirestoreAlertCooldownStore } from "./cooldown/firestore-cooldown-store.service";
import { COOLDOWN_STORE } from "./cooldown/cooldown-store.interface";
import { CHANNELS } from "./channel/channel.interface";
import { TelegramChannel } from "./channel/telegram.channel";
import { PubSubController } from "./pubsub/pubsub.controller";
import { ReportsController } from "./pubsub/reports.controller";

@Module({
    controllers: [PubSubController, ReportsController],
    providers: [
        AlertDispatcherConfigService,
        TelegramChannel,
        { provide: COOLDOWN_STORE, useClass: FirestoreAlertCooldownStore },
        // v1 delivers to Telegram only. A second channel (e.g. email) is added to this array behind its
        // own enable flag — see channel.interface.ts.
        { provide: CHANNELS, useFactory: (telegram: TelegramChannel) => [telegram], inject: [TelegramChannel] },
    ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {}
