import { Controller, Get } from "@nestjs/common";
import { FATLoggerService } from "./logger/fat.logger.provider";

@Controller()
export class AppController {
    constructor(private readonly logger: FATLoggerService) {}

    @Get("ping")
    ping(): string {
        this.logger.log("ping endpoint called");
        return "pong";
    }
}
