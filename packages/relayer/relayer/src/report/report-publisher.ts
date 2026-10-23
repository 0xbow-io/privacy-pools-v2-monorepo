import { PubSub, Topic } from "@google-cloud/pubsub";
import { redactText } from "../errors/redact";

/**
 * Publishes on-demand report results to the `relayer-reports` Pub/Sub topic, consumed by the
 * standalone `alert-dispatcher` service, which relays the text to the same Telegram chat the alert
 * path already pages into. Structurally identical to `logger/alert-publisher.ts` — see that file's
 * header for the failure-policy rationale (never break the caller, never log through Winston here).
 */

export type ReportCommand = "native_asset_balances" | "current_profit_margins";
export type ReportStatus = "ok" | "error";

export interface ReportInput {
    command: ReportCommand;
    status: ReportStatus;
    text: string;
    requestId: string;
}

/**
 * The wire format. The alert-dispatcher validates it with a hand-mirrored zod schema
 * (`zReportEvent`); `packages/relayer/alert-fixtures/report-events.json` is the shared contract
 * both sides are tested against — same drift-guard pattern as `AlertEvent`/`alert-events.json`.
 */
export interface ReportEvent extends ReportInput {
    /** ISO 8601, set at publish time. */
    timestamp: string;
}

export const DEFAULT_REPORTS_TOPIC = "relayer-reports";
const MAX_TEXT_LENGTH = 3800; // Telegram's 4096-char limit, minus headroom for the dispatcher's own formatting

let topic: Topic | undefined;
const inFlight = new Set<Promise<void>>();

function reportsDisabled(): boolean {
    return process.env.NODE_ENV === "test" || process.env.RELAYER_REPORTS_DISABLED === "true";
}

function getTopic(): Topic {
    topic ??= new PubSub().topic(process.env.RELAYER_REPORTS_PUBSUB_TOPIC ?? DEFAULT_REPORTS_TOPIC);
    return topic;
}

/**
 * `redactText` is deliberately single-line (it's built for log lines) — it would silently collapse
 * a multi-chain report down to its first line. Redact line-by-line instead so the per-chain
 * structure survives.
 */
function redactReportText(text: string): string {
    return text
        .split("\n")
        .map((line) => redactText(line))
        .join("\n");
}

function buildEvent(input: ReportInput): ReportEvent {
    return {
        command: input.command,
        status: input.status,
        text: redactReportText(input.text).slice(0, MAX_TEXT_LENGTH),
        requestId: input.requestId,
        timestamp: new Date().toISOString(),
    };
}

async function publish(input: ReportInput): Promise<void> {
    try {
        await getTopic().publishMessage({ json: buildEvent(input) });
    } catch (err) {
        // Plain console.error on purpose — never through Winston (would re-enter the alert/report
        // transport machinery and can loop if Pub/Sub itself is what's failing).
        console.error(`report-publisher: failed to publish report: ${redactText(err instanceof Error ? err.message : String(err))}`);
    }
}

/** Publishes a report result. Never rejects; a no-op under NODE_ENV=test or RELAYER_REPORTS_DISABLED=true. */
export function publishReport(input: ReportInput): Promise<void> {
    if (reportsDisabled()) return Promise.resolve();
    const pending: Promise<void> = publish(input).finally(() => {
        inFlight.delete(pending);
    });
    inFlight.add(pending);
    return pending;
}

/** Waits (bounded) for in-flight publishes. Mirrors `flushAlerts` — unused today (reports have no boot-time path) but kept symmetric in case one appears. */
export async function flushReports(timeoutMs = 3000): Promise<void> {
    if (inFlight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
    });
    try {
        await Promise.race([Promise.allSettled([...inFlight]), timeout]);
    } finally {
        clearTimeout(timer);
    }
}
