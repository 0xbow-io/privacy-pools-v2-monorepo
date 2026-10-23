import { z } from "zod";

/**
 * The alert wire format. HAND-MIRRORED from `AlertEvent` in the relayer
 * (packages/relayer/relayer/src/logger/alert-publisher.ts) — the two packages share no dependency.
 * Drift is guarded by the shared fixture packages/relayer/alert-fixtures/alert-events.json, which
 * both sides' specs check (see pubsub.schemas.spec.ts here and alert-publisher.spec.ts there).
 */
export const zAlertEvent = z.object({
    /** "turbo" = operator-page class; "warn" = degraded-but-not-down. */
    severity: z.enum(["turbo", "warn"]),
    message: z.string(),
    context: z.string(),
    dedupKey: z.string().min(1),
    timestamp: z.string().datetime(),
    requestId: z.string().optional(),
    meta: z.record(z.unknown()).optional(),
});

export type AlertEvent = z.infer<typeof zAlertEvent>;

/**
 * The on-demand report wire format. HAND-MIRRORED from `ReportEvent` in the relayer
 * (packages/relayer/relayer/src/report/report-publisher.ts) — the two packages share no dependency.
 * Drift is guarded by the shared fixture packages/relayer/alert-fixtures/report-events.json, which
 * both sides' specs check (see pubsub.schemas.spec.ts here and report-publisher.spec.ts there).
 */
export const zReportEvent = z.object({
    command: z.enum(["native_asset_balances", "current_profit_margins"]),
    status: z.enum(["ok", "error"]),
    text: z.string(),
    requestId: z.string().min(1),
    timestamp: z.string().datetime(),
});

export type ReportEvent = z.infer<typeof zReportEvent>;

/** Standard Pub/Sub push subscription envelope shape (same as dust-rescue-service). */
export const zPubSubPushEnvelope = z.object({
    message: z.object({
        data: z.string(), // base64
        messageId: z.string().optional(),
        publishTime: z.string().optional(),
    }),
    subscription: z.string().optional(),
});
