import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { ClsModule } from "nestjs-cls";
import { nanoid } from "nanoid";
import { AppController } from "./app.controller";
import { ReconcileController } from "./chain.service/reconcile.controller";
import { CoreModule } from "./core/core.module";
import { QuoteModule } from "./quote/quote.module";
import { RelayModule } from "./relay/relay.module";
import { DetailsModule } from "./details/details.module";
import { RequestLogInterceptor } from "./request.log.interceptor";
import { ConfigModule } from "./config/config.module";
import { TelegramModule } from "./telegram/telegram.module";

@Module({
    imports: [
        ThrottlerModule.forRoot([
            { name: "quote", ttl: 60_000, limit: 20 },
            { name: "relay", ttl: 60_000, limit: 5 },
        ]),
        ConfigModule,
        ClsModule.forRoot({
            global: true,
            middleware: {
                mount: true,
                setup: (cls) => {
                    cls.set("requestId", nanoid(15));
                },
            },
        }),
        CoreModule,
        DetailsModule.forRoot(),
        QuoteModule.forRoot(),
        RelayModule.forRoot(),
        TelegramModule,
    ],
    controllers: [AppController, ReconcileController],
    providers: [
        {
            provide: APP_GUARD,
            useClass: ThrottlerGuard,
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: RequestLogInterceptor,
        },
    ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {}
