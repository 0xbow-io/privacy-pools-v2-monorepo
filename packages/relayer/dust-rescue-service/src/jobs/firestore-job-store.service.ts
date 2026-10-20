import { Injectable, Logger } from "@nestjs/common";
import { Firestore } from "@google-cloud/firestore";
import type { Hex } from "viem";
import { DustRescueConfigService } from "../config/dust-rescue-config.service";
import { NON_TERMINAL_STATES, type DustRescueJob, type NewDustRescueJob } from "./job.types";
import { JobAlreadyExistsError, type IDustRescueJobStore } from "./job-store.interface";

/**
 * Firestore-backed job store (dust_collection_service_detailed_design.org §3). Document
 * ID = sourceTxHash — gives idempotent upsert against Pub/Sub's at-least-once push
 * delivery for free, no separate dedup table needed.
 */
@Injectable()
export class FirestoreDustRescueJobStore implements IDustRescueJobStore {
    private readonly logger = new Logger(FirestoreDustRescueJobStore.name);
    private readonly firestore = new Firestore();

    constructor(private readonly config: DustRescueConfigService) {}

    private collection() {
        return this.firestore.collection(this.config.firestoreCollection());
    }

    async createPending(job: NewDustRescueJob): Promise<void> {
        const now = Date.now();
        const doc: DustRescueJob = {
            ...job,
            state: "PENDING",
            attempts: 0,
            createdAt: now,
            updatedAt: now,
        };
        try {
            // `.create()` (not `.set()`) so a redelivered Pub/Sub push that races a second
            // create fails distinctly instead of silently overwriting progress already made
            // by the first delivery.
            await this.collection().doc(job.sourceTxHash).create(doc);
            this.logger.log(`Created pending dust rescue job ${job.sourceTxHash}`);
        } catch (e: unknown) {
            if (this.isAlreadyExists(e)) {
                throw new JobAlreadyExistsError(job.sourceTxHash);
            }
            throw e;
        }
    }

    async markAwaitingDestination(sourceTxHash: Hex): Promise<void> {
        await this.update(sourceTxHash, { state: "AWAITING_DESTINATION" });
    }

    async get(sourceTxHash: Hex): Promise<DustRescueJob | undefined> {
        const snap = await this.collection().doc(sourceTxHash).get();
        return snap.exists ? (snap.data() as DustRescueJob) : undefined;
    }

    // `in NON_TERMINAL_STATES` (not `not-in TERMINAL_STATES`) so this composes with
    // `.orderBy()` on a different field — Firestore's inequality-filter rules (which
    // `not-in` falls under) forbid that combination (finding #10, Problem A). Ordering
    // oldest-`updatedAt`-first plus the caller-supplied `limit` gives round-robin
    // fairness across sweeps: see sweep.service.ts's `touch()` calls on every WAIT
    // branch, which is what keeps a stuck job's `updatedAt` moving instead of pinning it
    // at the front (or back) of the queue forever.
    async listNonTerminal(limit: number): Promise<DustRescueJob[]> {
        const snap = await this.collection()
            .where("state", "in", NON_TERMINAL_STATES)
            .orderBy("updatedAt", "asc")
            .limit(limit)
            .get();
        return snap.docs.map((d) => d.data() as DustRescueJob);
    }

    async update(sourceTxHash: Hex, patch: Partial<DustRescueJob>): Promise<void> {
        await this.collection()
            .doc(sourceTxHash)
            .update({ ...patch, updatedAt: Date.now() });
    }

    async touch(sourceTxHash: Hex): Promise<void> {
        await this.collection().doc(sourceTxHash).update({ updatedAt: Date.now() });
    }

    private isAlreadyExists(e: unknown): boolean {
        // @google-cloud/firestore surfaces ALREADY_EXISTS as gRPC status code 6.
        return typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === 6;
    }
}
