import { PubSub, Topic } from "@google-cloud/pubsub";
import { clientSafeErrorMessage, redactText } from "../errors/redact";

/**
 * Publishes operational alerts to the `relayer-alerts` Pub/Sub topic, consumed by the standalone
 * `alert-dispatcher` service (packages/relayer/alert-dispatcher), which pages Telegram.
 *
 * A plain module, deliberately not a Nest provider: it is driven by the Winston `AlertTransport`
 * (see alert-transport.ts), which runs with no DI container (boot validators, main.ts). The
 * "logger-first constructor" convention (packages/relayer/CLAUDE.md §5) therefore doesn't apply —
 * there is no constructor.
 *
 * Failure policy: publishing an alert must never break the code path that raised it. Every error
 * is swallowed here and reported with a plain `console.error`, NEVER through the Winston logger —
 * that would re-enter the alert transport and loop forever if Pub/Sub itself is what's failing.
 */

export type AlertSeverity = "turbo" | "warn";

/** What a caller supplies; `timestamp` is stamped at publish time. */
export interface AlertInput {
    /** "turbo" = operator-page class; "warn" = degraded-but-not-down (e.g. swallowed dust-rescue failure). */
    severity: AlertSeverity;
    message: string;
    /** Emitting class/module name (mirrors FATLogger's `context`). */
    context: string;
    /** Stable across repeat occurrences of the same fault; never derived from free text. */
    dedupKey: string;
    requestId?: string;
    meta?: Record<string, unknown>;
}

/**
 * The wire format. The alert-dispatcher validates it with a hand-mirrored zod schema (`zAlertEvent`);
 * packages/relayer/alert-fixtures/alert-events.json is the shared contract both sides are tested against.
 */
export interface AlertEvent extends AlertInput {
    /** ISO 8601, set at publish time. */
    timestamp: string;
}

export const DEFAULT_ALERTS_TOPIC = "relayer-alerts";
const MAX_MESSAGE_LENGTH = 1000;
const MAX_DEDUP_KEY_LENGTH = 200;
const MAX_META_DEPTH = 4;
const DEFAULT_FLUSH_TIMEOUT_MS = 3000;

let topic: Topic | undefined;
const inFlight = new Set<Promise<void>>();

function alertsDisabled(): boolean {
    return process.env.NODE_ENV === "test" || process.env.RELAYER_ALERTS_DISABLED === "true";
}

function getTopic(): Topic {
    topic ??= new PubSub().topic(process.env.RELAYER_ALERTS_PUBSUB_TOPIC ?? DEFAULT_ALERTS_TOPIC);
    return topic;
}

/** Same privacy bar as logs and HTTP errors: RPC URLs and API keys must never leave the process. */
function redactValue(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return redactText(value);
    if (value instanceof Error) return clientSafeErrorMessage(value);
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    if (value === null || typeof value !== "object") return value;
    if (depth >= MAX_META_DEPTH) return "[truncated]";
    if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, depth + 1)]));
}

function buildEvent(input: AlertInput): AlertEvent {
    return {
        severity: input.severity,
        message: redactText(input.message).slice(0, MAX_MESSAGE_LENGTH),
        context: input.context,
        dedupKey: input.dedupKey.slice(0, MAX_DEDUP_KEY_LENGTH),
        timestamp: new Date().toISOString(),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        ...(input.meta !== undefined ? { meta: redactValue(input.meta) as Record<string, unknown> } : {}),
    };
}

async function publish(input: AlertInput): Promise<void> {
    try {
        await getTopic().publishMessage({ json: buildEvent(input) });
    } catch (err) {
        // Plain console.error on purpose — see the failure policy above.
        console.error(`alert-publisher: failed to publish alert: ${redactText(err instanceof Error ? err.message : String(err))}`);
    }
}

/** Publishes an alert. Never rejects; a no-op under NODE_ENV=test or RELAYER_ALERTS_DISABLED=true. */
export function publishAlert(input: AlertInput): Promise<void> {
    if (alertsDisabled()) return Promise.resolve();
    const pending: Promise<void> = publish(input).finally(() => {
        inFlight.delete(pending);
    });
    inFlight.add(pending);
    return pending;
}

/**
 * Waits (bounded) for in-flight publishes. Called by main.ts when bootstrap fails: the process is
 * about to crash, and a fire-and-forget publish would otherwise be killed before reaching Pub/Sub —
 * losing exactly the boot-time alerts that matter most. Never rejects.
 */
export async function flushAlerts(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
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
