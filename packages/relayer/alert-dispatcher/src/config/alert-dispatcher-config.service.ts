import { Injectable } from "@nestjs/common";
import { z } from "zod";

const DEFAULT_COOLDOWN_SECONDS = 900;
const DEFAULT_COOLDOWN_COLLECTION = "relayerAlertCooldowns";

const zEnv = z.object({
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_CHAT_ID: z.string().min(1),
    ALERT_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(DEFAULT_COOLDOWN_SECONDS),
    ALERT_COOLDOWN_COLLECTION: z.string().min(1).default(DEFAULT_COOLDOWN_COLLECTION),
});

/**
 * Env-var-only configuration (unlike dust-rescue-service there is no public config shape worth a
 * file): the bot token comes from Secret Manager as a mounted env var, the rest are plain env vars.
 * Validated in the constructor so a misconfigured deploy fails at boot, not on the first alert.
 * Error messages name the offending variables only — never their values (the token is a secret).
 */
@Injectable()
export class AlertDispatcherConfigService {
    private readonly env: z.infer<typeof zEnv>;

    constructor() {
        const parsed = zEnv.safeParse(process.env);
        if (!parsed.success) {
            const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].join(", ");
            throw new Error(`Invalid alert-dispatcher configuration; check these environment variables: ${names}`);
        }
        this.env = parsed.data;
    }

    telegramBotToken(): string {
        return this.env.TELEGRAM_BOT_TOKEN;
    }

    telegramChatId(): string {
        return this.env.TELEGRAM_CHAT_ID;
    }

    /** Minimum time between two pages for the same dedupKey. */
    cooldownMs(): number {
        return this.env.ALERT_COOLDOWN_SECONDS * 1000;
    }

    cooldownCollection(): string {
        return this.env.ALERT_COOLDOWN_COLLECTION;
    }
}
