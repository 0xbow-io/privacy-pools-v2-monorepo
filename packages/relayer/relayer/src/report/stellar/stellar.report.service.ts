import { Injectable, NotImplementedException, Scope } from "@nestjs/common";
import { formatUnits } from "viem";
import { StellarChainService } from "../../chain.service/stellar.chain.service";
import { StellarConfigService } from "../../config/stellar/stellar-config.service";
import type { IReportService, NativeBalanceReport, ProfitMarginReport, ReportOptions } from "../report.interface";

const STROOP_DECIMALS = 7; // 1 XLM = 10,000,000 stroops

/** Read-only Stellar reports: no signer key is ever used, only the signer's public address. */
@Injectable({ scope: Scope.REQUEST })
export class StellarReportService implements IReportService {
    constructor(
        private readonly config: StellarConfigService,
        private readonly chainService: StellarChainService
    ) {}

    async nativeAssetBalance(): Promise<NativeBalanceReport> {
        const balance = await this.chainService.nativeBalance();
        return {
            chainId: this.config.chainId(),
            chainName: `Stellar chain ${this.config.chainId()}`,
            amount: formatUnits(balance, STROOP_DECIMALS),
            symbol: "XLM",
        };
    }

    // No revenue/cost model exists for Stellar yet (different contracts and event shapes from EVM's
    // PrivacyPoolRelay/RelaySwaps/PoolVault — nothing to reuse, and designing one is new work, not a
    // refactor). Stubbed deliberately, same convention as `StellarRelayService.relayAndAnnounceSchema`.
    profitMargin(_opts?: ReportOptions): Promise<ProfitMarginReport> {
        throw new NotImplementedException("current_profit_margins is not yet supported on Stellar");
    }
}
