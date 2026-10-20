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

    intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
        return next.handle().pipe(
            timeout(QUOTE_DEADLINE_MS),
            catchError((err: unknown) => {
                if (err instanceof TimeoutError) {
                    const error = `Quote deadline (${QUOTE_DEADLINE_MS}ms) exceeded — upstream RPC unresponsive`;
                    this.logger.error(error);
                    return throwError(() => new ServiceUnavailableException(error));
                }
                return throwError(() => err);
            })
        );
    }
}
