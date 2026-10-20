import { z } from "zod";

export const HTTPClientConfigSchema = z.object({
    timeout: z.number().positive("timeout must be positive").optional().default(15_000),
    retryAttempts: z
        .number()
        .int("retryAttempts must be an integer")
        .nonnegative("retryAttempts must be non-negative")
        .optional()
        .default(3),
    retryDelay: z.number().nonnegative("retryDelay must be non-negative").optional().default(500),
    headers: z.record(z.string(), z.string()).optional(),
});
