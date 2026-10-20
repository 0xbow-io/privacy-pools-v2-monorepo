/**
 * The ASP's page cap on the two public yield feeds (`yield-deposits`, `ppusdc-rate-history`):
 * `PublicService.YIELD_FEED_PAGE_SIZE` on asp-v2. A page with fewer rows is the caught-up signal;
 * exactly this many rows means another page must be asked for.
 */
export const YIELD_FEED_PAGE_SIZE = 1000;

/**
 * Drain guard: at most this many pages per drain (25 x 1000 rows), so a runaway feed or a
 * cursor bug can never turn one read into an unbounded request storm. Hitting it is an
 * incomplete drain and is reported as an error, never as a thinner feed.
 */
export const YIELD_FEED_MAX_PAGES = 25;

/**
 * The lowest value `Note.createdAtBlock` can hold and still be a unix timestamp
 * (2001-09-09). Every producer in this SDK stores the on-chain `block.timestamp` there, but a
 * legacy export can still carry a real block number, and a block number read as a timestamp is
 * 1970: it clamps onto the first rate observation and prints a confident wrong figure. Below
 * this, the time is treated as missing.
 */
export const MIN_PLAUSIBLE_NOTE_TIMESTAMP = 1_000_000_000;
