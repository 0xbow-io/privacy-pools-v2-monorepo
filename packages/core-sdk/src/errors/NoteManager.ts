import { Label } from "../internal.js";

/** Base error class for all NoteManager-related errors. */
export class NoteManagerBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "NoteManagerBaseError";
    }
}

/** Thrown when a note with the given commitment hash doesn't exist. */
export class NoteNotFoundError extends NoteManagerBaseError {
    /** @param commitmentHash - The commitment hash that was not found. */
    constructor(commitmentHash: string) {
        super(`Note not found: ${commitmentHash}`);
        this.name = "NoteNotFoundError";
    }
}

/** Thrown when a status transition is not allowed by the lifecycle rules. */
export class InvalidStatusTransitionError extends NoteManagerBaseError {
    /** @param from - The current status. */
    /** @param to - The attempted new status. */
    constructor(from: string, to: string) {
        super(`Invalid status transition: ${from} -> ${to}`);
        this.name = "InvalidStatusTransitionError";
    }
}

/** Thrown when a note fails schema validation. */
export class InvalidNoteError extends NoteManagerBaseError {
    /** @param message - Description of the validation failure. */
    constructor(message: string) {
        super(`Invalid note: ${message}`);
        this.name = "InvalidNoteError";
    }
}

/**
 * Thrown when a different note already holds a commitment. The commitment is a
 * note's identity, so two notes that disagree on value, token, label, owner, or
 * secret cannot share one. Overwriting the stored note would bring a spent note
 * back to a spendable status, or change the lineage total. `addNote` rejects
 * instead. An identical re-add is allowed and is a no-op.
 */
export class NoteConflictError extends NoteManagerBaseError {
    /** @param commitmentHash - The commitment already held by a different note. */
    constructor(commitmentHash: string) {
        super(`Conflicting note for commitment: ${commitmentHash}`);
        this.name = "NoteConflictError";
    }
}

/** Thrown when a lineage structure is invalid or doesn't exist. */
export class InvalidLineageError extends NoteManagerBaseError {
    /** @param label - The label of the invalid or missing lineage. */
    constructor(label: Label) {
        super(`Invalid or missing lineage: ${label}`);
        this.name = "InvalidLineageError";
    }
}
