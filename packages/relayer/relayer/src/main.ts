import { NestFactory } from "@nestjs/core";
import { VersioningType } from "@nestjs/common";
import { AppModule } from "./app.module";
import { RelayerConfig } from "./config/relayer-config";
import { FATLogger } from "./logger/fat.logger";
import { flushAlerts } from "./logger/alert-publisher";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { installBigIntJson } from "./bigint-json";

installBigIntJson();

async function bootstrap() {
    const app = await NestFactory.create(AppModule, {
        bufferLogs: true,
    });
    const logger = new FATLogger("Bootstrap");
    app.useLogger(logger);
    // CORS: allow browser clients (ppv2 and similar) to call quote / relay /
    // details from the origin they are served from. Configured via the "cors"
    // section of relayer.config.json (exact `origins` + regex `origin_patterns`,
    // e.g. Vercel preview deployments), overridable with CORS_ORIGIN /
    // CORS_ORIGIN_PATTERN. Defaults to "*" when nothing is configured — set a
    // real allowlist in production, or any website can call the signing and
    // relay routes from a browser.
    app.enableCors({
        origin: app.get(RelayerConfig).corsOrigins(),
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["content-type", "authorization"],
        maxAge: 86400,
    });
    app.enableVersioning({
        type: VersioningType.URI,
        defaultVersion: "1",
    });
    // Adding Open Api Documentation
    const config = new DocumentBuilder()
        // TODO should we cconsume this from a configuration?
        .setTitle("Privacy Pools Relayer")
        .setDescription("Relayer API")
        .setVersion("1.0")
        .addTag("privacy_pools")
        .build();
    const documentFactory = () => SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api", app, documentFactory);

    await app.listen(process.env.PORT ?? 3000);

    // Opt-in heartbeat alert (packages/relayer/CLAUDE.md §4b): pages Telegram at severity "warn"
    // on every boot. A silent redeploy with no page is a sign the alert path itself is broken.
    logger.error("Relayer started", { alert: true, dedupKey: "relayer.restart" });
}
bootstrap().catch(async (e) => {
    console.error(e);
    // Boot validators log `turbo` and throw; the alert transport publishes fire-and-forget, so give
    // those in-flight alerts a bounded chance to reach Pub/Sub before the unhandled rejection below
    // takes the process down.
    await flushAlerts();
    throw new Error(`Bootstrap failed: ${e.message ?? e}`);
});
