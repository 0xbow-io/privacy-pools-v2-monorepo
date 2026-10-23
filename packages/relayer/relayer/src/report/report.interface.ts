/**
 * One interface, implemented per `ChainType`, resolved lazily — same shape as `RELAY_SERVICE` /
 * `IRelayService` (relay/relay.interface.ts) and `QUOTE_SERVICE` / `IQuoteService`. The difference
 * from those two: `REPORT_SERVICE` is never resolved from a real inbound HTTP request (there is no
 * `/report/:chainType/:chainId` route). `ReportsService` (report/reports.service.ts) synthesizes a
 * request-scoped context per configured chain instead, so it can fan a single Telegram command out
 * across every chain of every type in one pass — see that file for why.
 *
 * Every method is read-only: no implementation may hold or use a signer's private key. Reports are
 * intentionally read-only across the whole path (Telegram -> relayer -> dispatcher), never signing
 * or broadcasting, the same boundary `docs/tech-design/relayer/alert-dispatcher.md` already draws
 * around what the alert path may touch.
 */
export interface NativeBalanceReport {
    chainId: number;
    chainName: string;
    /** Formatted (not raw units), e.g. "1.2345". */
    amount: string;
    symbol: string;
}

export interface ProfitMarginReport {
    chainId: number;
    chainName: string;
    /** Human-readable, pre-formatted lines — already HTML-escaped where needed by the caller. */
    summary: string;
}

/** Reserved for future command arguments (chain filter, tx count, ...) — unused in this pass. */
export interface ReportOptions {
    args?: string[];
}

export interface IReportService {
    nativeAssetBalance(opts?: ReportOptions): Promise<NativeBalanceReport>;
    profitMargin(opts?: ReportOptions): Promise<ProfitMarginReport>;
}

export const REPORT_SERVICE = Symbol("REPORT_SERVICE");
