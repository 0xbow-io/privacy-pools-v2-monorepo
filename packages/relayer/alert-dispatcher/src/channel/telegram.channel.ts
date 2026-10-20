import { Injectable } from "@nestjs/common";
import { AlertDispatcherConfigService } from "../config/alert-dispatcher-config.service";
import type { AlertEvent } from "../pubsub/pubsub.schemas";
import type { IAlertChannel } from "./channel.interface";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const REQUEST_TIMEOUT_MS = 10_000;

const SEVERITY_PREFIX: Record<AlertEvent["severity"], string> = {
    turbo: "🔴 <b>CRITICAL</b>",
    warn: "🟡 <b>WARN</b>",
};

/** Telegram's HTML parse mode only needs these three escaped. */
export function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatAlert(event: AlertEvent): string {
    const lines = [
        `${SEVERITY_PREFIX[event.severity]} · <code>${escapeHtml(event.context)}</code>`,
        escapeHtml(event.message),
        `<i>${escapeHtml(event.dedupKey)} · ${escapeHtml(event.timestamp)}${event.requestId ? ` · req ${escapeHtml(event.requestId)}` : ""}</i>`,
    ];
    const text = lines.join("\n");
    // Truncating HTML mid-tag would make Telegram reject the message, so shorten the free text instead.
    if (text.length <= TELEGRAM_MESSAGE_LIMIT) return text;
    // Nothing left to shorten (an absurdly long context): hard-cut as a last resort rather than recurse forever.
    if (event.message.length <= 1) return text.slice(0, TELEGRAM_MESSAGE_LIMIT);
    const overflow = text.length - TELEGRAM_MESSAGE_LIMIT + 1;
    return formatAlert({ ...event, message: `${event.message.slice(0, Math.max(0, event.message.length - overflow))}…` });
}

/**
 * Delivers alerts to a Telegram chat through the Bot API (global `fetch`, no extra dependency).
 *
 * Errors NEVER include the request URL: it contains the bot token. Failures throw (so the controller
 * answers 5xx and Pub/Sub redelivers) with only the HTTP status and Telegram's own `description`.
 */
@Injectable()
export class TelegramChannel implements IAlertChannel {
    constructor(private readonly config: AlertDispatcherConfigService) {}

    async send(event: AlertEvent): Promise<void> {
        let response: Response;
        try {
            response = await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken()}/sendMessage`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    chat_id: this.config.telegramChatId(),
                    text: formatAlert(event),
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            throw new Error(`Telegram request failed: ${reason}`);
        }

        if (!response.ok) {
            let description = "";
            try {
                description = ((await response.json()) as { description?: string }).description ?? "";
            } catch {
                // non-JSON error body: the status alone is enough
            }
            throw new Error(`Telegram sendMessage failed: HTTP ${response.status}${description ? ` (${description})` : ""}`);
        }
    }
}
