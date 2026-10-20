/**
 * Maximum number of transacts (single-label note groups) a single batch
 * withdrawal may contain.
 *
 * This value MUST match the relay contract's `MAX_BATCH` (the contract sums and
 * caps per-item fees over exactly this many items) and MUST stay strictly below
 * the pool's `rootHistorySize`: every item proves against a state root that has
 * to remain in the pool's root history when the batch settles, so a batch larger
 * than the history window could have an early item's root evicted before the
 * batch lands and revert on-chain.
 */
export const MAX_BATCH = 10;
