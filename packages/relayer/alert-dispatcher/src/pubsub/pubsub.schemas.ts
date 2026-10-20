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

/** Standard Pub/Sub push subscription envelope shape (same as dust-rescue-service). */
export const zPubSubPushEnvelope = z.object({
    message: z.object({
        data: z.string(), // base64
        messageId: z.string().optional(),
        publishTime: z.string().optional(),
    }),
    subscription: z.string().optional(),
});
