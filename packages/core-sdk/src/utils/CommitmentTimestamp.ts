import type { Hash, Hex, ILogger, IPoolVaultInteractor } from "../internal.js";
import { sleep } from "./sleep.js";

/**
 * Default number of attempts before giving up.
 * Sized for transient RPC inconsistency / reorg windows after a successful tx.
 */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Default initial backoff between attempts (doubles each attempt, capped at 4×). */
const DEFAULT_BACKOFF_MS = 200;

/** Cap on the backoff multiplier so the helper bounds total wall time. */
const MAX_BACKOFF_MULTIPLIER = 4;

/** Options for {@link resolveCommitmentTimestamp}. */
export interface ResolveCommitmentTimestampOptions {
    /** Maximum lookup attempts. Defaults to {@link DEFAULT_MAX_ATTEMPTS}. */
    maxAttempts?: number;
    /** Initial backoff in ms; doubles per attempt up to a 4× cap. */
    backoffMs?: number;
    /** Optional logger for debug + warn output. */
    logger?: ILogger;
}

/**
 * What a bounded timestamp lookup established about a commitment.
 *
 * - `found`: contract storage holds it, with this timestamp.
 * - `absent`: the node answered, and storage has no entry (a `0x0` read).
 * - `unknown`: every attempt threw, so nothing is known either way.
 *
 * The last two used to be one `null`. A caller that gives up on an absent
 * commitment must not give up on an unknown one: a flaky RPC during a catch-up
 * sync is not evidence the note is not there.
 */
export type CommitmentTimestampLookup =
    | { status: "found"; timestamp: Hex }
    | { status: "absent" }
    | { status: "unknown" };

/**
 * Looks up the on-chain commitment timestamp with bounded retry, and says why
 * when it cannot.
 *
 * Treats both thrown errors and a `0x0` response as transient while attempts
 * remain: after a successful tx receipt the storage entry must exist, so a zero
 * or thrown result is most likely RPC inconsistency or a reorg window. When the
 * attempts run out, any clean `0x0` answer makes it `absent`; only a run in
 * which every attempt threw is `unknown`.
 */
export async function lookupCommitmentTimestamp<TTx, TAddress, TProof, TLog>(
    poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>,
    commitment: Hash,
    opts: ResolveCommitmentTimestampOptions = {},
): Promise<CommitmentTimestampLookup> {
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    const logger = opts.logger;
    let answeredZero = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const timestamp = await poolVaultInteractor.getCommitmentTimestamp(commitment);
            if (BigInt(timestamp) !== 0n) return { status: "found", timestamp };
            answeredZero = true;
            logger?.debug("Commitment timestamp returned 0x0; retrying", {
                commitment,
                attempt,
                maxAttempts,
            });
        } catch (error) {
            logger?.debug("Commitment timestamp lookup threw; retrying", {
                commitment,
                attempt,
                maxAttempts,
                error: error instanceof Error ? error.message : String(error),
            });
        }

        if (attempt < maxAttempts) {
            const multiplier = Math.min(2 ** (attempt - 1), MAX_BACKOFF_MULTIPLIER);
            await sleep(backoffMs * multiplier);
        }
    }

    logger?.warn("Could not resolve commitment timestamp after retries", {
        commitment,
        maxAttempts,
        outcome: answeredZero ? "absent" : "unknown",
    });
    return answeredZero ? { status: "absent" } : { status: "unknown" };
}

/**
 * Resolves the on-chain commitment timestamp with bounded retry.
 *
 * {@link lookupCommitmentTimestamp} without the reason: callers that only need
 * a timestamp or nothing keep this shape.
 *
 * @returns the resolved timestamp on success, or `null` if it could not be
 *   resolved after `maxAttempts`. Callers MUST NOT persist a note with a
 *   `null` / `0x0` `createdAtBlock` — the witness uses `createdAtBlock` to
 *   recompute the timestamped state-tree leaf, and a stale value silently
 *   breaks ragequit / transact proofs.
 */
export async function resolveCommitmentTimestamp<TTx, TAddress, TProof, TLog>(
    poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>,
    commitment: Hash,
    opts: ResolveCommitmentTimestampOptions = {},
): Promise<Hex | null> {
    const lookup = await lookupCommitmentTimestamp(poolVaultInteractor, commitment, opts);
    return lookup.status === "found" ? lookup.timestamp : null;
}
