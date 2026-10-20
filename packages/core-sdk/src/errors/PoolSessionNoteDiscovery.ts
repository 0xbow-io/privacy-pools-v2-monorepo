/** Base error class for all PoolSessionNoteDiscovery errors. */
export class PoolSessionNoteDiscoveryBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "PoolSessionNoteDiscoveryBaseError";
    }
}

/** Thrown when the note discovery scan fails. */
export class NoteDiscoveryScanFailed extends PoolSessionNoteDiscoveryBaseError {
    /** @param reason - Underlying error detail. */
    constructor(reason: string) {
        super(`Note discovery scan failed: ${reason}`);
        this.name = "NoteDiscoveryScanFailed";
    }
}

/**
 * Thrown when local note state disagrees with an invariant the chain enforces
 * (e.g. a ragequit event arriving for a commitment already marked SPENT — the
 * contract rejects publishing a nullifier twice, so this can only mean the ASP
 * snapshot, the event parse, or the local state is corrupt). Not retryable:
 * surfaces to the caller so they can rebuild state or escalate.
 */
export class StateInvariantViolation extends PoolSessionNoteDiscoveryBaseError {
    /** @param reason - Forensic detail describing the inconsistency. */
    constructor(reason: string) {
        super(`State invariant violation: ${reason}`);
        this.name = "StateInvariantViolation";
    }
}
