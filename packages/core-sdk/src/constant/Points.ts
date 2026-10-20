/** Fixed-point decimals of every point amount: points-wei, 18 decimals. */
export const POINTS_DECIMALS = 18;

/** An unreached cohort milestone publishes `POINTS_COHORT_EDGE_SENTINEL + tier`. */
export const POINTS_COHORT_EDGE_SENTINEL = 1n << 47n;

/** Below this a `createdAt` / `spentAt` is not a unix timestamp (2001-09-09). */
export const MIN_PLAUSIBLE_POINTS_TIMESTAMP = 1_000_000_000n;

/** Drain guard on the epochs feed and the cohort series: hitting it is an incomplete drain. */
export const POINTS_FEED_MAX_PAGES = 100;

/**
 * Domain tag of spent-note tree leaves: `leaf = Poseidon(TAG, nullifierHash, spentAt)`. The same
 * constant the state tree uses (contracts `Constants.NULLIFIER_LEAF_TAG`).
 */
export const POINTS_NULLIFIER_LEAF_TAG =
    1480564842420020354887207755615370381236762558448265256256653429412951563031n;

/** A rate-leaf tokenId at or above this is a padding leaf, never a token. */
export const POINTS_MAX_TOKEN_ID = 1n << 160n;
