import type { AlertEvent } from "../pubsub/pubsub.schemas";

/** Proof that this delivery won the cooldown race; needed to roll the claim back if sending fails. */
export interface CooldownClaim {
    /** The `lastSentAt` this claim wrote. */
    claimedAt: number;
    /** What `lastSentAt` was before the claim (0 when the dedupKey had never paged). */
    previousLastSentAt: number;
}

/**
 * Per-dedupKey cooldown, safe across Cloud Run instances.
 *
 * Deliberately NOT the permanent one-shot dedup of dust-rescue-service's job store: an ongoing outage
 * should keep paging periodically (once per cooldown window), not once forever.
 */
export interface IAlertCooldownStore {
    /**
     * Atomically decides whether this alert may be sent. Returns a claim when it may (and records
     * `lastSentAt = now`), or undefined when the dedupKey paged within the cooldown window (and
     * records the suppressed occurrence).
     */
    tryAcquire(event: AlertEvent): Promise<CooldownClaim | undefined>;

    /**
     * Rolls a claim back after a failed send, so Pub/Sub's redelivery of the same alert isn't
     * suppressed by our own failed attempt. A no-op if a newer claim has since replaced it.
     */
    release(event: AlertEvent, claim: CooldownClaim): Promise<void>;
}

export const COOLDOWN_STORE = Symbol("COOLDOWN_STORE");
