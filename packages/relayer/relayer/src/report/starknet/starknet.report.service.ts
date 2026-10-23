import { Injectable, NotImplementedException, Scope } from "@nestjs/common";
import type { IReportService, NativeBalanceReport, ProfitMarginReport, ReportOptions } from "../report.interface";

/**
 * Stubbed for both commands. Unlike EVM/Stellar, there is no `StarknetChainService` or chain-level
 * config wired into `core.module.ts` yet (`config/types.ts`'s `ChainConfig` union doesn't include a
 * Starknet config type either) — balance reads need that groundwork before this can be real. Kept
 * as an explicit `NotImplementedException`, not silently missing, so an operator asking for Starknet
 * gets an honest answer instead of a wrong or empty one.
 */
@Injectable({ scope: Scope.REQUEST })
export class StarknetReportService implements IReportService {
    nativeAssetBalance(_opts?: ReportOptions): Promise<NativeBalanceReport> {
        throw new NotImplementedException("native_asset_balances is not yet supported on Starknet");
    }

    profitMargin(_opts?: ReportOptions): Promise<ProfitMarginReport> {
        throw new NotImplementedException("current_profit_margins is not yet supported on Starknet");
    }
}
