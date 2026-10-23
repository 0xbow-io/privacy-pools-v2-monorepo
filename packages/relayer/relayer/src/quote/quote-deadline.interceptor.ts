import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
    ServiceUnavailableException,
} from "@nestjs/common";
import { Observable, TimeoutError, catchError, throwError, timeout } from "rxjs";
import { FATLoggerService } from "../logger/fat.logger.provider";

// Hard ceiling on quote handling. Transport timeouts (evm.chain.service.ts)
// bound each RPC call, but a quote chains several; this bounds the sum so a
// degraded provider yields a clean, retryable 503 instead of a hanging client.
// Must stay comfortably below the perf suite's PERF_DEADLINE_BUDGET_MS (9s).
export const QUOTE_DEADLINE_MS = Number(process.env.QUOTE_DEADLINE_MS ?? 8_000);

@Injectable()
export class QuoteDeadlineInterceptor implements NestInterceptor {
    constructor(private readonly logger: FATLoggerService) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        return next.handle().pipe(
            timeout(QUOTE_DEADLINE_MS),
            catchError((err: unknown) => {
                if (err instanceof TimeoutError) {
                    const error = `Quote deadline (${QUOTE_DEADLINE_MS}ms) exceeded — upstream RPC unresponsive`;
                    // Operator fault: an unresponsive upstream pages, keyed per chain. The chain id is
                    // normalized exactly as routing does (CHAIN_CONTEXT, core.module.ts), so "8453",
                    // "08453" and "0x2105" share one cooldown key instead of bypassing it.
                    const { chainType, chainId } = context.switchToHttp().getRequest<{ params: Record<string, string> }>().params;
                    this.logger.error(error, { alert: true, dedupKey: `quote.deadline.${chainType}.${Number(chainId)}` });
                    return throwError(() => new ServiceUnavailableException(error));
                }
                return throwError(() => err);
            })
        );
    }
}
