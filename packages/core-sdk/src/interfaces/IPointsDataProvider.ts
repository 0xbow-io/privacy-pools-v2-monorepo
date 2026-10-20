import type {
    Hex,
    PointsCohorts,
    PointsEpoch,
    PointsRateLeaves,
    PointsStats,
    SpentNoteLeaves,
} from "../internal.js";

/**
 * Reads the ASP's public points API.
 *
 * No method takes a commitment, nullifier, label or address, and leaf sets are always fetched
 * whole, so no request names a note. Membership and gap witnesses are assembled locally from the
 * full set. The epoch number IS in the request path, though: a caller that fetches only the epochs
 * its own notes touch reveals that selection. To keep the request stream independent of the notes
 * held, fetch every published epoch (or none), never a note-driven subset.
 *
 * Every served leaf set is checked against the root served with it. Those roots come from the same
 * server; compare them with the epoch row (and, once the points registry is live, with the root
 * pinned on chain) before building a claim from them.
 */
export interface IPointsDataProvider {
    /**
     * Retrieves every published epoch, all pages drained, ascending by feed id.
     *
     * A correction rewrites an epoch row in place (same feed id), so a cached copy must be
     * refreshed by draining from the start, never by resuming from a saved cursor.
     *
     * @throws {PointsBaseError}
     */
    getEpochs(): Promise<PointsEpoch[]>;

    /**
     * Retrieves the most recent published epoch.
     *
     * @returns The latest epoch, or `null` when none has been published yet.
     * @throws {PointsBaseError}
     */
    getLatestEpoch(): Promise<PointsEpoch | null>;

    /**
     * Retrieves the complete sorted spent-note leaf set of one epoch, verified against its
     * `spentNoteRoot`.
     *
     * @param epochNumber - Per-pool epoch number.
     * @throws {PointsBaseError}
     */
    getSpentNoteLeaves(epochNumber: Hex): Promise<SpentNoteLeaves>;

    /**
     * Retrieves the complete rate tree of one epoch, with its rate scale, cliff and cohort
     * schedule, verified against its `rateRoot`.
     *
     * @param epochNumber - Per-pool epoch number.
     * @throws {PointsBaseError}
     */
    getRateLeaves(epochNumber: Hex): Promise<PointsRateLeaves>;

    /**
     * Retrieves the campaign's TVL-milestone cohort schedule, every series page drained.
     *
     * @throws {PointsBaseError}
     */
    getCohorts(): Promise<PointsCohorts>;

    /**
     * Retrieves display-only aggregate stats.
     *
     * @throws {PointsBaseError}
     */
    getStats(): Promise<PointsStats>;
}
