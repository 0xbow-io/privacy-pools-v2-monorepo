/**
 * Lifecycle states of a privacy-pool note.
 *
 * INACTIVE → PENDING → ACTIVE → SPENT | EXIT_PENDING → EXITED
 */
export enum NoteStatus {
    INACTIVE = "INACTIVE",
    PENDING = "PENDING",
    ACTIVE = "ACTIVE",
    SPENT = "SPENT",
    /**
     * A ragequit was submitted and mined, but its block is not settled yet.
     *
     * The one non-terminal exit state, and the reason it exists: `EXITED` has no
     * outgoing edge, while a mined transaction can still be reorged out. Writing
     * `EXITED` straight from a success receipt therefore records — irreversibly —
     * an exit the canonical chain may never contain, and the note it hides is one
     * the user still owns. That is the same failure this SDK now guards against on
     * the discovery side; a receipt is no more final than a log.
     *
     * A note here is NOT spendable. Spendability is an allowlist on `ACTIVE`
     * everywhere it is decided (`selectNotesForFullWithdraw`,
     * `BatchWithdrawOrchestrator`, `NoteManager` lineage), so this state is
     * excluded by construction rather than by remembering to exclude it.
     *
     * It resolves both ways: discovery promotes it to `EXITED` once the chain's own
     * ragequit event for it is final, and back to `ACTIVE` if the exit turns out
     * never to have happened.
     */
    EXIT_PENDING = "EXIT_PENDING",
    EXITED = "EXITED",
    REJECTED = "REJECTED",
}
