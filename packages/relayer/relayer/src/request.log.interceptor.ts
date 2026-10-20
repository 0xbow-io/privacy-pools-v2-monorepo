import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { Request } from "express";
import { FATLoggerService } from "./logger/fat.logger.provider";

@Injectable()
export class RequestLogInterceptor implements NestInterceptor {
    constructor(private readonly logger: FATLoggerService) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const request = context.switchToHttp().getRequest<Request>();

        if (request.method !== "POST") {
            return next.handle();
        }

        // Privacy: never log request bodies or response payloads. Relay/quote
        // bodies carry proof, noteData and recipient routing — logging them
        // links users to withdrawals (audit R-H4). Route params are only
        // chainType/chainId; requestId is attached by FATLoggerService.
        const { method, path, params } = request;
        const startedAt = Date.now();

        this.logger.info("Request received", { method, path, params });

        return next.handle().pipe(
            tap(() => {
                this.logger.info("Request completed", { path, durationMs: Date.now() - startedAt });
            })
        );
    }
}
