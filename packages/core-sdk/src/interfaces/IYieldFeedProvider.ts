import type { Address, YieldDepositFact, YieldRateSeries } from "../internal.js";

/**
 * Reads the ASP's two public yield feeds, whole.
 *
 * Both feeds are caller-independent bulk data: the same bytes go to every client. That property
 * is the whole reason a yield-earned figure can be computed at all without telling the ASP which
 * notes this wallet holds, so the fetchers take ONLY the share address (public configuration) and
 * the server's own page cursor from the previous page. No `since`, `from`, `after=<timestamp>`,
 * no "only the pages covering my notes", no stopping early once the wallet's oldest note is
 * covered: any of those turns the request stream into a function of the wallet's notes. Full
 * feed, every page, every time.
 *
 * The provider never schedules these calls either. The consumer fetches them on a fixed public
 * cadence, unrelated to anything the user does, and hands the result to
 * {@link IPoolSessionYieldEarned.compute}.
 *
 * One more rule that belongs to the CALLER, because the interface cannot enforce it: fetch the
 * series for every share the deployment configures, not only the ones this wallet holds. The
 * `share` argument is public configuration, but the SET of shares asked about is not — a client
 * that only ever requests ppETH's history has said it holds ppETH. Same reasoning as the fixed
 * cadence: what is asked, and when, both have to be independent of the wallet.
 *
 * Note for implementers wiring this up: `PoolSessionBuilder` resolves the ASP provider
 * internally and the built session exposes no handle to it, so a consumer that lets the builder
 * construct the provider cannot reach these methods. Construct the provider yourself and keep a
 * reference — and if you wrap it in an object literal, forward these two methods with the rest,
 * or they are silently dropped.
 */
export interface IYieldFeedProvider {
    /**
     * Drains `GET /:chainId/public/ppusdc-rate-history?asset=<share>` page by page and returns
     * the whole history ascending by time.
     *
     * @param share - The share token (public configuration) to read the history of.
     * @returns The full series, or `null` when the ASP answers 404 (no yield pool on this chain).
     * @throws {ASPClientBaseError} When a page fails, the drain cannot complete, or the payload fails validation.
     */
    getYieldRateSeries(share: Address): Promise<YieldRateSeries | null>;

    /**
     * Drains `GET /:chainId/public/yield-deposits` page by page and returns every fact of
     * `share`. The request carries no filter: the feed is fetched whole and narrowed locally.
     *
     * @param share - The share token whose deposit facts to keep.
     * @returns The facts, or `null` when the ASP answers 404 (no yield pool on this chain).
     * @throws {ASPClientBaseError} When a page fails, the drain cannot complete, or the payload fails validation.
     */
    getYieldDepositFacts(share: Address): Promise<readonly YieldDepositFact[] | null>;
}
