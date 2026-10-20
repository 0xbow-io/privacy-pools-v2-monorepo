import type { Hex } from "viem";
import type { DustRescueJob, NewDustRescueJob } from "./job.types";

export const JOB_STORE = Symbol("JOB_STORE");

/** Thrown by `createPending` when a job with the same `sourceTxHash` already exists. */
export class JobAlreadyExistsError extends Error {
    constructor(sourceTxHash: Hex) {
        super(`Dust rescue job ${sourceTxHash} already exists`);
        this.name = "JobAlreadyExistsError";
    }
}

/**
 * The seam unit tests fake instead of touching real Firestore. See
 * dust_collection_service_detailed_design.org §3.
 */
export interface IDustRescueJobStore {
    /** @throws {JobAlreadyExistsError} if a job with this sourceTxHash already exists. */
    createPending(job: NewDustRescueJob): Promise<void>;
    markAwaitingDestination(sourceTxHash: Hex): Promise<void>;
    get(sourceTxHash: Hex): Promise<DustRescueJob | undefined>;
    /** Oldest-touched first, capped at `limit` — see firestore-job-store.service.ts. */
    listNonTerminal(limit: number): Promise<DustRescueJob[]>;
    update(sourceTxHash: Hex, patch: Partial<DustRescueJob>): Promise<void>;
    /** Bumps `updatedAt` only — no state change. Distinct from `update()` so a sweep pass
     * that merely re-examined a job (still WAITing) can't be confused with one that
     * actually advanced it. */
    touch(sourceTxHash: Hex): Promise<void>;
}
