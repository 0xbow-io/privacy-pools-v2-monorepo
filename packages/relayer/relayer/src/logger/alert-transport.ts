import * as winston from "winston";
import { AlertSeverity, publishAlert } from "./alert-publisher";

/**
 * Turns log records into operator alerts. Registered in `winstonConfig.transports` (fat.logger.ts),
 * so every FATLogger / FATLoggerService instance is covered with no call-site changes.
 *
 * A record is an alert when:
 *   1. its level is `turbo`            -> severity "turbo" (operator-page class), or
 *   2. its meta carries `alert: true`  -> severity "warn"  (degraded, not down).
 * Everything else is ignored — `error`/`warn` volume is far too high to alert on by level alone, so
 * non-turbo alerts are strictly opt-in via the marker:
 *
 *     this.logger.error("Dust rescue registration failed", { alert: true, dedupKey: "dustRescue.8453" });
 *
 * NOTE: the alerting path is implicit — a `turbo` log pages without anything at the call site saying so.
 * The marker keys (`alert`, `dedupKey`) are consumed here and stripped from Console output.
 */
export const ALERT_MARKER_KEYS = ["alert", "dedupKey"] as const;

// Keys of a winston record that are not free-form meta.
const RESERVED_KEYS = new Set<string>(["level", "message", "context", "requestId", "timestamp", ...ALERT_MARKER_KEYS]);

export function classifyAlert(info: Record<string, unknown>): AlertSeverity | undefined {
    if (info.level === "turbo") return "turbo";
    if (info.alert === true) return "warn";
    return undefined;
}

/** Winston format that removes the alert marker keys, so they don't pollute the Console output. */
export const stripAlertMarkers = winston.format((info) => {
    // Static deletes (kept in step with ALERT_MARKER_KEYS above); `info` must stay the same object so
    // winston's symbol-keyed internals (LEVEL / MESSAGE / SPLAT) are preserved.
    delete info.alert;
    delete info.dedupKey;
    return info;
});

// winston's typings declare the base class as `winston.transport` (lowercase), but at runtime it is only
// exported as `winston.Transport` — `extends winston.transport` evaluates to `undefined` and throws at load.
const TransportBase = (winston as unknown as { Transport: new () => winston.transport }).Transport;

export class AlertTransport extends TransportBase {
    log(info: Record<string, unknown>, callback: () => void): void {
        try {
            const severity = classifyAlert(info);
            if (severity) {
                const context = typeof info.context === "string" && info.context ? info.context : "unknown";
                const dedupKey = typeof info.dedupKey === "string" && info.dedupKey ? info.dedupKey : context;
                const meta = Object.fromEntries(Object.entries(info).filter(([key]) => !RESERVED_KEYS.has(key)));
                // Fire-and-forget: a slow or failing Pub/Sub must never block logging. publishAlert never rejects.
                void publishAlert({
                    severity,
                    message: String(info.message),
                    context,
                    dedupKey,
                    ...(typeof info.requestId === "string" ? { requestId: info.requestId } : {}),
                    ...(Object.keys(meta).length > 0 ? { meta } : {}),
                });
            }
        } catch (err) {
            // A bug in alert construction must never break logging (and must not log through winston).
            console.error(`alert-transport: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setImmediate(() => this.emit("logged", info));
            callback();
        }
    }
}
