import type { AlertEvent } from "../pubsub/pubsub.schemas";

/**
 * A delivery channel for alerts — the seam for adding email (or anything else) later: implement this,
 * add it to the CHANNELS array in app.module.ts behind its own enable flag. No change to the route,
 * the cooldown logic, or the AlertEvent schema.
 */
export interface IAlertChannel {
    /** Delivers the alert. MUST throw on failure so Pub/Sub redelivers the message. */
    send(event: AlertEvent): Promise<void>;
}

export const CHANNELS = Symbol("CHANNELS");
