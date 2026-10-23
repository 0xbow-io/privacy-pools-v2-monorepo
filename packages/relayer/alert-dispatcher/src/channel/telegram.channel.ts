import { Injectable } from "@nestjs/common";
import { AlertDispatcherConfigService } from "../config/alert-dispatcher-config.service";
import type { AlertEvent, ReportEvent } from "../pubsub/pubsub.schemas";
import type { IAlertChannel } from "./channel.interface";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const REQUEST_TIMEOUT_MS = 10_000;

const SEVERITY_PREFIX: Record<AlertEvent["severity"], string> = {
    turbo: "🔴 <b>CRITICAL</b>",
    warn: "🟡 <b>WARN</b>",
};

const REPORT_STATUS_PREFIX: Record<ReportEvent["status"], string> = {
    ok: "📊 <b>REPORT</b>",
    error: "⚠️ <b>REPORT (partial failure)</b>",
};

/** Telegram's HTML parse mode only needs these three escaped. */
export function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Shortens `rawText` so `prefix + "\n" + escape(text)` fits Telegram's 4096-char limit.
 * `prefix` is already escaped HTML. `rawText` is truncated BEFORE it is escaped, so a cut can never
 * land inside an entity such as `&amp;` (which would make Telegram reject the whole message).
 */
function fitMessage(prefix: string, rawText: string): string {
    let text = rawText;
    for (;;) {
        const full = `${prefix}\n${escapeHtml(text)}`;
        if (full.length <= TELEGRAM_MESSAGE_LIMIT) return full;
        if (text.length <= 1) return full.slice(0, TELEGRAM_MESSAGE_LIMIT);
        const overflow = full.length - TELEGRAM_MESSAGE_LIMIT + 1;
        text = `${text.slice(0, Math.max(0, text.length - overflow))}…`;
    }
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
 * The relayer's redaction is trusted for report text the same way it is for alerts (see
 * `pubsub.controller.ts`'s doc comment) — only HTML-escaped here, not re-scrubbed.
 */
export function formatReport(event: ReportEvent): string {
    const prefix = `${REPORT_STATUS_PREFIX[event.status]} · <code>${escapeHtml(event.command)}</code>`;
    return fitMessage(prefix, event.text);
}

/**
 * Delivers alerts and on-demand reports to a Telegram chat through the Bot API (global `fetch`, no
 * extra dependency).
 *
 * Errors NEVER include the request URL: it contains the bot token. Failures throw (so the controller
 * answers 5xx and Pub/Sub redelivers) with only the HTTP status and Telegram's own `description`.
 */
@Injectable()
export class TelegramChannel implements IAlertChannel {
    constructor(private readonly config: AlertDispatcherConfigService) {}

    async send(event: AlertEvent): Promise<void> {
        await this.sendText(formatAlert(event));
    }

    async sendReport(event: ReportEvent): Promise<void> {
        await this.sendText(formatReport(event));
    }

    private async sendText(text: string): Promise<void> {
        let response: Response;
        try {
            response = await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken()}/sendMessage`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    chat_id: this.config.telegramChatId(),
                    text,
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
