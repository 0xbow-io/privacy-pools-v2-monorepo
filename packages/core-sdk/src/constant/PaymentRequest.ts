/**
 * Default scan-expiry window: a request stops being scannable this long after `createdAt`.
 *
 * Stamped onto the record at generation as `expiresAt` and shared with the sender — it is never
 * recomputed from `createdAt` on a later scan, so changing this value does not re-date any
 * existing record (#600).
 */
export const DEFAULT_REQUEST_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Extra time the RECIPIENT keeps scanning after a request's `expiresAt`.
 *
 * The sender's guard (`PoolSessionTransfer.prepareFulfillPaymentRequest`) refuses at `expiresAt`
 * exactly, but a payment that passes that check still has to prove, submit, and be included.
 * Without a grace period a sender who pays seconds before the deadline creates a note that is
 * on-chain, valid, and already outside the recipient's scan set — the #600 silent loss again, in
 * a smaller window.
 *
 * The grace is deliberately on the recipient side only. Widening the scan set can only find more
 * of the user's own notes; widening the sender's window would instead let it hand out payments
 * the recipient has genuinely stopped watching for. The two sides are therefore *meant* to
 * disagree, with the recipient's bound strictly the later of the pair.
 *
 * 24h is far longer than any prove-and-include path and still bounds the scan set, which is the
 * property #600 actually requires: bounded by the recipient or by time, never by an
 * attacker-craftable flip.
 */
export const SCAN_EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000;
