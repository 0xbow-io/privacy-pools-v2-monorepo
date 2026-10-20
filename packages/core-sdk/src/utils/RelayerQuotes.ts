import type {
    ILogger,
    IRelayerInteractor,
    PrepareTransferRelayerQuotes,
    PrepareWithdrawRelayerQuotes,
    TransferQuoteParams,
    WithdrawalQuoteParams,
} from "../internal.js";
import { FeeCommitmentExpired, RelayerRequestFailed } from "../internal.js";

// NOTE (core-sdk split): the original packages/sdk/src/utils/RelayerQuotes.ts also exported
// `settleSwapRelayerQuotes` (a per-relayer swap-quote fan-out, using the excluded SwapQuoteParams
// / PrepareSwapRelayerQuotes types). Dropped here along with those imports — it belongs in
// evm-sdk alongside the withdraw-and-swap / reshield session classes that call it.

/**
 * Fan out a per-relayer fetch via `Promise.allSettled` and return only the
 * successful results. Used by the domain-specific wrappers
 * `settleWithdrawRelayerQuotes` and `settleTransferRelayerQuotes` so a single
 * unhealthy relayer cannot collapse the whole quote step.
 *
 * - Empty `relayers` returns `[]` (lets test/empty-config paths through).
 * - Non-empty input that produces zero successes throws `RelayerRequestFailed`
 *   with all per-relayer failure messages concatenated.
 * - Mixed outcomes return only the fulfilled values; rejections are logged at
 *   `warn` level so the caller can surface them in operator UIs.
 */
export async function settleRelayerQuotes<TInfo extends { name: string }, TQuote>(
    relayers: TInfo[],
    fetch: (relayer: TInfo) => Promise<TQuote>,
    logger?: ILogger,
): Promise<TQuote[]> {
    const settled = await Promise.allSettled(relayers.map(fetch));
    const result: TQuote[] = [];
    const failures: string[] = [];
    for (const [index, outcome] of settled.entries()) {
        if (outcome.status === "fulfilled") {
            result.push(outcome.value);
        } else {
            const reason =
                outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
            failures.push(`${relayers[index]!.name}: ${reason}`);
        }
    }
    if (failures.length > 0) {
        logger?.warn("Some relayers failed to quote", { failures });
    }
    if (relayers.length > 0 && result.length === 0) {
        throw new RelayerRequestFailed(
            `All configured relayers failed to quote: ${failures.join("; ")}`,
        );
    }
    logger?.debug("Received relayer quotes", { result });
    return result;
}

/**
 * Domain wrapper around {@link settleRelayerQuotes} for withdrawal quote
 * fan-out. Resolves the relayer list from `relayerInteractor` and fetches a
 * withdrawal quote from each, returning `{ relayerInfo, quote }` pairs.
 *
 * @throws {RelayerRequestFailed} When every configured relayer fails to quote.
 */
export async function settleWithdrawRelayerQuotes<TAddress>(
    relayerInteractor: IRelayerInteractor<TAddress>,
    params: WithdrawalQuoteParams<TAddress>,
    logger?: ILogger,
): Promise<PrepareWithdrawRelayerQuotes<TAddress>[]> {
    const relayers = await relayerInteractor.getRelayers();
    return settleRelayerQuotes(
        relayers,
        async (relayer) => ({
            relayerInfo: relayer,
            quote: await relayerInteractor.getWithdrawalQuote(relayer, params),
        }),
        logger,
    );
}

/**
 * Domain wrapper around {@link settleRelayerQuotes} for transfer quote
 * fan-out. Resolves the relayer list from `relayerInteractor` and fetches a
 * transfer quote from each, returning `{ relayerInfo, quote }` pairs.
 *
 * @throws {RelayerRequestFailed} When every configured relayer fails to quote.
 */
export async function settleTransferRelayerQuotes<TAddress>(
    relayerInteractor: IRelayerInteractor<TAddress>,
    params: TransferQuoteParams<TAddress>,
    logger?: ILogger,
): Promise<PrepareTransferRelayerQuotes<TAddress>[]> {
    const relayers = await relayerInteractor.getRelayers();
    return settleRelayerQuotes(
        relayers,
        async (relayer) => ({
            relayerInfo: relayer,
            quote: await relayerInteractor.getTransferQuote(relayer, params),
        }),
        logger,
    );
}

/**
 * Throws if a relayer's signed fee commitment has already expired.
 *
 * The pool contract does not check expiration. The relayer signs `expiration`
 * off-chain as a promise it will not relay past that timestamp. So this is the
 * only place expiry is enforced before submission, and it fails fast instead of
 * burning proof time on a quote the relayer will reject anyway.
 *
 * Best-effort: it reads the local client clock, not an authoritative source.
 * The relayer is the final authority on expiry. A skewed client clock can let
 * an expired quote pass or reject a live one. Callers run this before proof
 * generation; the relay submission methods run it again to catch a commitment
 * that expires during proof generation.
 *
 * @param expirationMs - The commitment's `expiration` (Unix milliseconds, as emitted
 *   by the relayer via `Number(new Date()) + quoteExpirationMs`).
 * @throws {FeeCommitmentExpired} If `expirationMs` is at or before now.
 */
export function assertFeeCommitmentLive(expirationMs: number): void {
    const nowMs = Date.now();
    if (expirationMs <= nowMs) {
        throw new FeeCommitmentExpired(
            `Fee commitment expired at ${expirationMs}, current time ${nowMs}`,
        );
    }
}
// `settleSwapRelayerQuotes` (swap-quote fan-out) was dropped along with the imports above —
// see the NOTE at the top of this file.
