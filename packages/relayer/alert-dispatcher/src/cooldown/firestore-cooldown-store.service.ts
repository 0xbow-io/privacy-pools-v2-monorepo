import { Injectable } from "@nestjs/common";
import { Firestore } from "@google-cloud/firestore";
import { createHash } from "crypto";
import { AlertDispatcherConfigService } from "../config/alert-dispatcher-config.service";
import type { AlertEvent } from "../pubsub/pubsub.schemas";
import type { CooldownClaim, IAlertCooldownStore } from "./cooldown-store.interface";

interface CooldownDoc {
    dedupKey: string;
    lastSentAt: number;
    lastSeverity: string;
    lastMessage: string;
    occurrenceCount: number;
}

/**
 * Firestore-backed cooldown: one document per dedupKey, so two Cloud Run instances racing on the
 * same key can't both decide to page (the read-check-write runs in a transaction, which Firestore
 * retries on contention).
 *
 * Uses the Firestore SDK with ambient (ADC) credentials, like dust-rescue-service's job store; the
 * runtime service account needs roles/datastore.user. Lookups are by document id, so no composite
 * index is needed. Timestamps are plain `Date.now()` numbers, like the sibling store.
 */
@Injectable()
export class FirestoreAlertCooldownStore implements IAlertCooldownStore {
    private readonly firestore = new Firestore();

    constructor(private readonly config: AlertDispatcherConfigService) {}

    private collection() {
        return this.firestore.collection(this.config.cooldownCollection());
    }

    /** Document id: a hash of the dedupKey, since Firestore ids can't contain "/" and keys are free-form. */
    private docId(dedupKey: string): string {
        return createHash("sha256").update(dedupKey).digest("hex");
    }

    async tryAcquire(event: AlertEvent): Promise<CooldownClaim | undefined> {
        const ref = this.collection().doc(this.docId(event.dedupKey));
        const windowMs = this.config.cooldownMs();

        return this.firestore.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const existing = snap.exists ? (snap.data() as CooldownDoc) : undefined;
            const now = Date.now();
            const occurrenceCount = (existing?.occurrenceCount ?? 0) + 1;

            if (existing && now - existing.lastSentAt < windowMs) {
                // Within the cooldown: record the suppressed occurrence, don't page.
                tx.update(ref, { occurrenceCount });
                return undefined;
            }

            const doc: CooldownDoc = {
                dedupKey: event.dedupKey,
                lastSentAt: now,
                lastSeverity: event.severity,
                lastMessage: event.message,
                occurrenceCount,
            };
            tx.set(ref, doc);
            return { claimedAt: now, previousLastSentAt: existing?.lastSentAt ?? 0 };
        });
    }

    async release(event: AlertEvent, claim: CooldownClaim): Promise<void> {
        const ref = this.collection().doc(this.docId(event.dedupKey));

        await this.firestore.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) return;
            // Only undo our own claim — a newer claim by another delivery must be left alone.
            if ((snap.data() as CooldownDoc).lastSentAt !== claim.claimedAt) return;
            tx.update(ref, { lastSentAt: claim.previousLastSentAt });
        });
    }
}
