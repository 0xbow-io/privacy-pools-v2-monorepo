import { Injectable } from "@nestjs/common";
import { ModuleRef, ContextIdFactory } from "@nestjs/core";
import { nanoid } from "nanoid";
import { ChainType } from "../config/enums";
import { RelayerConfig } from "../config/relayer-config";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { redactText } from "../errors/redact";
import { REPORT_SERVICE, type IReportService, type NativeBalanceReport, type ProfitMarginReport } from "./report.interface";
import type { FakeChainRequest } from "./report.module";
import { publishReport, type ReportCommand } from "./report-publisher";

// Starknet/Solana excluded here, not just unimplemented: `zChains` (config/schemas.ts) has no
// `starknet`/`solana` key yet, so `RelayerConfig.chain()` can't even type-check against them —
// there is no chain-level config to enumerate. `StarknetReportService` still exists as scaffolding
// for once that config support lands; until then it's unreachable from this loop.
const CHAIN_TYPES_IN_SCOPE = [ChainType.EVM, ChainType.STELLAR] as const;

const CHAIN_TYPE_LABELS: Record<ChainType, string> = {
    [ChainType.EVM]: "EVM",
    [ChainType.STELLAR]: "Stellar",
    [ChainType.STARKNET]: "Starknet",
    [ChainType.SOLANA]: "Solana",
};

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** For log lines only: RPC URLs (and their API keys) can appear in viem errors, and the logger does not scrub. */
function loggableError(e: unknown): string {
    return redactText(errorMessage(e));
}

function formatResult(command: ReportCommand, result: NativeBalanceReport | ProfitMarginReport): string {
    if (command === "native_asset_balances") {
        const r = result as NativeBalanceReport;
        return `${r.chainName} (${r.chainId}): ${r.amount} ${r.symbol}`;
    }
    return (result as ProfitMarginReport).summary;
}

/**
 * Orchestrates a Telegram report command across every configured chain of every type, in one pass.
 * Deliberately NOT request-scoped and NOT chain-bound, unlike every other relayer service
 * (`EvmConfigService`, `EVMChainService`, `EvmRelayService`, ...) — those answer one chain per
 * inbound HTTP request (`/relay/:chainType/:chainId/...`); a report command has no such single
 * chain, it must fan out across all of them. See `report.module.ts`'s `FakeChainRequest` for how
 * each chain's `REPORT_SERVICE` gets resolved without a real HTTP request driving it.
 *
 * Called by `TelegramWebhookController` without being awaited (fire-and-forget, same rule
 * `logger/alert-publisher.ts` follows) — Telegram's webhook delivery must never be held open while
 * this runs, so this method itself never throws; every outcome, including total failure, ends in a
 * `publishReport` call.
 */
@Injectable()
export class ReportsService {
    constructor(
        private readonly logger: FATLoggerService,
        private readonly relayerConfig: RelayerConfig,
        private readonly moduleRef: ModuleRef
    ) {}

    async handle(command: ReportCommand, args: string[]): Promise<void> {
        const requestId = nanoid(15);
        try {
            if (args.length > 0) {
                await publishReport({
                    command,
                    status: "error",
                    text: "Arguments aren't supported yet — resend the command with no arguments.",
                    requestId,
                });
                return;
            }

            const lines: string[] = [];
            let anyFailure = false;
            for (const chainType of CHAIN_TYPES_IN_SCOPE) {
                const chain = this.relayerConfig.chain(chainType);
                if (!chain.exists()) continue;
                for (const cfg of chain.allConfigs()) {
                    try {
                        const service = await this.resolveReportService(chainType, cfg.id);
                        const result = command === "native_asset_balances" ? await service.nativeAssetBalance() : await service.profitMargin();
                        lines.push(formatResult(command, result));
                    } catch (e) {
                        anyFailure = true;
                        lines.push(`${CHAIN_TYPE_LABELS[chainType]} chain ${cfg.id}: ${errorMessage(e)}`);
                        this.logger.error(`report ${command} failed for ${chainType}:${cfg.id}: ${loggableError(e)}`);
                    }
                }
            }

            await publishReport({
                command,
                status: anyFailure ? "error" : "ok",
                text: lines.length ? lines.join("\n\n") : "No chains configured.",
                requestId,
            });
        } catch (e) {
            // Belt and suspenders: nothing above should throw past its own try/catch, but a report
            // that silently vanishes (vs. one that visibly failed) is worse than a generic error reply.
            this.logger.error(`report ${command} failed unexpectedly: ${loggableError(e)}`);
            await publishReport({ command, status: "error", text: `Report failed: ${errorMessage(e)}`, requestId });
        }
    }

    /**
     * Synthesizes a request-scoped context for one chain and resolves its `REPORT_SERVICE` under
     * it — see `report.module.ts`'s `FakeChainRequest` doc for why `contextId` travels on the
     * payload itself rather than being recovered via `ContextIdFactory.getByRequest`.
     */
    private async resolveReportService(chainType: ChainType, chainId: number): Promise<IReportService> {
        const contextId = ContextIdFactory.create();
        const fakeRequest: FakeChainRequest = { params: { chainType, chainId: String(chainId) }, contextId };
        this.moduleRef.registerRequestByContextId(fakeRequest, contextId);
        return this.moduleRef.resolve(REPORT_SERVICE, contextId, { strict: false });
    }
}
