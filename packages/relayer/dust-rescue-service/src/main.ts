import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });
    await app.listen(process.env.PORT ?? 8080);
}
bootstrap().catch((e) => {
    console.error(e);
    throw new Error(`Bootstrap failed: ${e.message ?? e}`);
});
