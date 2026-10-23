import { BadRequestException, CallHandler, ExecutionContext, ServiceUnavailableException } from "@nestjs/common";
import { NEVER, lastValueFrom, of, throwError } from "rxjs";
import { QUOTE_DEADLINE_MS, QuoteDeadlineInterceptor } from "./quote-deadline.interceptor";
import { createMockLogger } from "../test/mocks";
import { FATLoggerService } from "../logger/fat.logger.provider";

describe("QuoteDeadlineInterceptor", () => {
    let interceptor: QuoteDeadlineInterceptor;
    let logger: ReturnType<typeof createMockLogger>;
    const context = {
        switchToHttp: () => ({ getRequest: () => ({ params: { chainType: "evm", chainId: "8453" } }) }),
    } as unknown as ExecutionContext;

    beforeEach(() => {
        logger = createMockLogger();
        interceptor = new QuoteDeadlineInterceptor(logger as unknown as FATLoggerService);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("passes a fast response through unchanged", async () => {
        const next: CallHandler = { handle: () => of({ feeAmount: "1" }) };
        const result = await lastValueFrom(interceptor.intercept(context, next));
        expect(result).toEqual({ feeAmount: "1" });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it("converts a handler that exceeds the deadline into a 503", async () => {
        jest.useFakeTimers();
        const next: CallHandler = { handle: () => NEVER };
        const resultPromise = lastValueFrom(interceptor.intercept(context, next));
        // Attach the rejection expectation before advancing time so the
        // rejection is never unhandled.
        const assertion = expect(resultPromise).rejects.toBeInstanceOf(ServiceUnavailableException);
        jest.advanceTimersByTime(QUOTE_DEADLINE_MS + 1);
        await assertion;
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Quote deadline"), {
            alert: true,
            dedupKey: "quote.deadline.evm.8453",
        });
    });

    it.each(["8453", "08453", "0x2105"])(
        "keys the deadline alert on the normalized chain id for chainId %s (one cooldown key per chain)",
        async (chainId) => {
            jest.useFakeTimers();
            const ctx = {
                switchToHttp: () => ({ getRequest: () => ({ params: { chainType: "evm", chainId } }) }),
            } as unknown as ExecutionContext;
            const next: CallHandler = { handle: () => NEVER };
            const resultPromise = lastValueFrom(interceptor.intercept(ctx, next));
            const assertion = expect(resultPromise).rejects.toBeInstanceOf(ServiceUnavailableException);
            jest.advanceTimersByTime(QUOTE_DEADLINE_MS + 1);
            await assertion;
            expect(logger.error).toHaveBeenCalledWith(expect.any(String), {
                alert: true,
                dedupKey: "quote.deadline.evm.8453",
            });
        }
    );

    it("propagates non-timeout errors untouched", async () => {
        const upstreamError = new BadRequestException("bad asset");
        const next: CallHandler = { handle: () => throwError(() => upstreamError) };
        await expect(lastValueFrom(interceptor.intercept(context, next))).rejects.toBe(upstreamError);
        expect(logger.error).not.toHaveBeenCalled();
    });
});
