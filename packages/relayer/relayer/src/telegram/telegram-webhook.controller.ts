import { timingSafeEqual } from "crypto";
import { Body, Controller, Headers, HttpCode, Post } from "@nestjs/common";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { redactText } from "../errors/redact";
import { ReportsService } from "../report/reports.service";
import { TelegramConfigService } from "./telegram-config.service";
import { parseCommand, zTelegramUpdate } from "./telegram-update.schemas";

const COMMAND_COOLDOWN_MS = 30_000;

function timingSafeEqualStrings(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    // Length must match for timingSafeEqual; a length mismatch is itself not secret-dependent
    // (the configured secret's length isn't attacker-controlled), so returning early here doesn't
    // reopen a timing side channel for the token's actual value.
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

/**
 * Receives Telegram Bot API webhook updates directly on the relayer — the relayer is already a
 * public service, so this adds a route to it rather than opening any new ingress on the (otherwise
 * fully private) alert-dispatcher. This controller does nothing privileged itself: it authenticates
 * the sender, parses a known command, and hands off to `ReportsService`, which is the only thing
 * that reads chain state (read-only; no signer key anywhere in this path). See
 * `docs/tech-design/relayer/relayer-reports.md`.
 *
 * Auth is Telegram's own `secret_token` header (set once via `setWebhook`), checked here at the
 * app level — NOT Cloud Run IAM, because the relayer must stay public for its normal quote/relay
 * traffic. A second check confirms the update's chat matches the one authorized operator chat.
 * Both failure cases return 200 with no detail in the body: Telegram doesn't need an explanation,
 * and a prober shouldn't get one either.
 */
@Controller("telegram")
export class TelegramWebhookController {
    private readonly lastRunAt = new Map<string, number>();

    constructor(
        private readonly logger: FATLoggerService,
        private readonly config: TelegramConfigService,
        private readonly reports: ReportsService
    ) {}

    @Post("webhook")
    @HttpCode(200)
    async webhook(@Headers("x-telegram-bot-api-secret-token") secretToken: string | undefined, @Body() body: unknown): Promise<void> {
        if (!this.config.isConfigured()) return;
        if (!secretToken || !timingSafeEqualStrings(secretToken, this.config.webhookSecret())) return;

        const parsedUpdate = zTelegramUpdate.safeParse(body);
        if (!parsedUpdate.success) return;
        const { message } = parsedUpdate.data;
        if (!message?.text) return;
        if (String(message.chat.id) !== this.config.authorizedChatId()) return;

        const parsedCommand = parseCommand(message.text);
        if (!parsedCommand) return;

        const lastRun = this.lastRunAt.get(parsedCommand.command) ?? 0;
        if (Date.now() - lastRun < COMMAND_COOLDOWN_MS) return;
        this.lastRunAt.set(parsedCommand.command, Date.now());

        // Fire-and-forget: Telegram's webhook delivery must not be held open while this runs
        // (current_profit_margins can take a while) — same rule alert-publisher.ts follows.
        void this.reports.handle(parsedCommand.command, parsedCommand.args).catch((e: unknown) => {
            // Redacted: viem errors can carry the RPC URL, and this logger does not scrub on its own.
            this.logger.error(`telegram command ${parsedCommand.command} failed: ${redactText(e instanceof Error ? e.message : String(e))}`);
        });
    }
}
