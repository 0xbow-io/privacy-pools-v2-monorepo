import { ExceptionFilter, Catch, ArgumentsHost } from "@nestjs/common";
import { Response } from "express";
import { ZodValidationException } from "nestjs-zod";
import { ZodError } from "zod";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { redactText } from "../errors/redact";

@Catch(ZodValidationException, ZodError)
export class ZodValidationFilter implements ExceptionFilter {
    constructor(private readonly logger: FATLoggerService) {}

    catch(exception: ZodValidationException | ZodError, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();

        const zodError = exception instanceof ZodError ? exception : exception.getZodError();

        const errors = zodError.errors.reduce(
            (acc, err) => {
                // Path and message get the same URL / key hygiene as every other
                // error body: a custom refinement may embed upstream text, and a
                // path segment is a response key (codex on #399).
                const path = redactText(err.path.join(".")) || "body";
                acc[path] = redactText(err.message);
                return acc;
            },
            Object.create(null) as Record<string, string>
        );

        this.logger.warn("Validation error", { errors });

        response.status(400).json({
            statusCode: 400,
            error: "Validation Error",
            message: errors,
        });
    }
}
