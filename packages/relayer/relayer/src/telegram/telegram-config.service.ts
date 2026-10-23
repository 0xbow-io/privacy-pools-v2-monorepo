import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";

const zEnv = z.object({
    TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
    TELEGRAM_AUTHORIZED_CHAT_ID: z.string().min(1).optional(),
});

/**
 * Env-var-only configuration for the Telegram command webhook. Unlike `AlertDispatcherConfigService`
 * (a dedicated service whose only job is alerting, so missing config failing its boot is fine),
 * this lives inside the main relayer process — the revenue-generating service. Missing/invalid
 * config here must NEVER fail the relayer's boot; it must instead leave the webhook permanently
 * disabled (`isConfigured() === false`), logged once, so an unconfigured or partially-rolled-out
 * deploy of this optional side feature can never take the relayer itself down.
 */
@Injectable()
export class TelegramConfigService {
    private readonly logger = new Logger(TelegramConfigService.name);
    private readonly webhookSecretValue?: string;
    private readonly authorizedChatIdValue?: string;

    constructor() {
        const parsed = zEnv.safeParse(process.env);
        if (!parsed.success) {
            const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].join(", ");
            this.logger.warn(`Telegram webhook disabled: invalid configuration for ${names}`);
            return;
        }
        if (!parsed.data.TELEGRAM_WEBHOOK_SECRET || !parsed.data.TELEGRAM_AUTHORIZED_CHAT_ID) {
            this.logger.warn("Telegram webhook disabled: TELEGRAM_WEBHOOK_SECRET / TELEGRAM_AUTHORIZED_CHAT_ID not set");
            return;
        }
        this.webhookSecretValue = parsed.data.TELEGRAM_WEBHOOK_SECRET;
        this.authorizedChatIdValue = parsed.data.TELEGRAM_AUTHORIZED_CHAT_ID;
    }

    isConfigured(): boolean {
        return this.webhookSecretValue !== undefined && this.authorizedChatIdValue !== undefined;
    }

    /** Only call when {@link isConfigured} is true. */
    webhookSecret(): string {
        if (!this.webhookSecretValue) throw new Error("Telegram webhook is not configured");
        return this.webhookSecretValue;
    }

    /** Only call when {@link isConfigured} is true. */
    authorizedChatId(): string {
        if (!this.authorizedChatIdValue) throw new Error("Telegram webhook is not configured");
        return this.authorizedChatIdValue;
    }
}
