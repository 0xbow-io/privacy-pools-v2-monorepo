import type {
    Address,
    AddNoteParams,
    MarkNoteExitedParams,
    MarkNoteSpentParams,
} from "../internal.js";

/**
 * Bookkeeping facade for integrators who broadcast their own transactions and
 * never reach the SDK's `execute*` path. Methods are batch-shaped: a single
 * broadcast can produce multiple output notes and consume multiple inputs.
 * Generic over the chain's address type `TAddress`.
 *
 * All methods validate the entire batch before any mutation and flush once on
 * success; partial application on caller-input errors is the hazard this
 * surface exists to prevent.
 */
export interface IPoolSessionNoteManager<TAddress = Address> {
    /**
     * Inserts each output note as `PENDING`. `createdAtBlock` is resolved
     * on-chain (broadcast tx MUST be mined). Discovery promotes to `ACTIVE`
     * on its next run.
     *
     * Rejects `pendingNote.isOwned === false` — recipient outputs from
     * `prepareTransfer` and `prepareDepositFor` outputs must not enter the
     * sender's NoteManager.
     *
     * @throws {PoolSessionNoteManagerBaseError}
     */
    addNotes(params: AddNoteParams<TAddress>[]): Promise<void>;

    /**
     * Transitions input notes `ACTIVE → SPENT` after external transact /
     * withdraw broadcasts. Without this, the next `prepare*` may re-select
     * the inputs and emit a proof that reverts at the nullifier check.
     *
     * @throws {PoolSessionNoteManagerBaseError}
     */
    markNotesSpent(params: MarkNoteSpentParams[]): Promise<void>;

    /**
     * Ragequit companion: transitions notes to `EXITED`. Use this instead of
     * {@link IPoolSessionNoteManager.markNotesSpent} on ragequit'd
     * commitments — `SPENT` is terminal with no `SPENT → EXITED` edge, so
     * marking spent would later wedge `discoverNotes()` when it observes the
     * ragequit event (`processRagequitEvents` raises
     * `StateInvariantViolation`).
     *
     * Accepts `ACTIVE` (normal) and `REJECTED` (ASP-rejected failsafe)
     * source statuses.
     *
     * @throws {PoolSessionNoteManagerBaseError}
     */
    markNotesExited(params: MarkNoteExitedParams[]): Promise<void>;
}
