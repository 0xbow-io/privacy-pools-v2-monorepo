import { NoteStatus } from "../internal.js";

/**
 * Valid status transitions: `from → Set<to>`.
 *
 * `*→REJECTED` is permitted from `PENDING` and `ACTIVE` so the discovery
 * loop can demote a note when its label flips to rejected on the ASP
 * (sub-1875). Without the PENDING→REJECTED edge, discovery aborts as
 * soon as a pending note's label is revoked; without the ACTIVE→REJECTED
 * edge, locally-cached ACTIVE notes keep inflating the spendable balance
 * after revocation and only surface the failure at proof-witness time.
 *
 * `REJECTED` is NOT a terminal state — ASP label-status is reversible, so a
 * note rejected on one scan can be legitimately re-approved on a later one
 * (RC-04 #501). Two guarded recovery edges leave REJECTED, both consumed only
 * by `PoolSessionNoteDiscovery.syncNotesStatus` AFTER on-chain spend
 * reconciliation has run:
 *   - `REJECTED→SPENT` lets the on-chain spend reconciliation demote a rejected
 *     note that was nonetheless spent on-chain, instead of the transition
 *     throwing and being swallowed. This resolves BEFORE any re-activation, so
 *     a spent note can never be restored to ACTIVE (double-count hazard).
 *   - `REJECTED→ACTIVE` re-activates a note whose label is approved again, but
 *     only when the discovery has confirmed the note's nullifier is NOT spent
 *     on-chain (guarding the same double-count hazard).
 * `REJECTED→EXITED` remains the ragequit failsafe.
 */
export const VALID_STATUS_TRANSITIONS: Record<NoteStatus, Set<NoteStatus>> = {
    [NoteStatus.INACTIVE]: new Set([
        NoteStatus.INACTIVE,
        NoteStatus.PENDING,
        NoteStatus.EXIT_PENDING,
        NoteStatus.EXITED,
    ]),
    [NoteStatus.PENDING]: new Set([
        NoteStatus.PENDING,
        NoteStatus.ACTIVE,
        NoteStatus.EXIT_PENDING,
        NoteStatus.EXITED,
        NoteStatus.REJECTED,
    ]),
    [NoteStatus.ACTIVE]: new Set([
        NoteStatus.ACTIVE,
        NoteStatus.SPENT,
        NoteStatus.EXIT_PENDING,
        NoteStatus.EXITED,
        NoteStatus.REJECTED,
    ]),
    [NoteStatus.SPENT]: new Set([NoteStatus.SPENT]),
    /**
     * The only exit state with a way back, and it needs every one of these edges.
     *
     * `EXITED` is the settled outcome, written once the chain's own ragequit event
     * for this note is final. `ACTIVE` is the reorg path: a mined exit that the
     * canonical chain drops leaves a note the user still owns, and without this
     * edge it would be stranded in a state nothing can spend — the very shape of
     * failure this state exists to avoid. `SPENT` covers the case where the exit
     * was dropped and the note was then consumed by an ordinary transact instead.
     */
    [NoteStatus.EXIT_PENDING]: new Set([
        NoteStatus.EXIT_PENDING,
        NoteStatus.EXITED,
        NoteStatus.ACTIVE,
        NoteStatus.SPENT,
    ]),
    [NoteStatus.EXITED]: new Set([NoteStatus.EXITED]),
    [NoteStatus.REJECTED]: new Set([
        NoteStatus.REJECTED,
        NoteStatus.ACTIVE,
        NoteStatus.SPENT,
        NoteStatus.EXIT_PENDING,
        NoteStatus.EXITED,
    ]),
};
