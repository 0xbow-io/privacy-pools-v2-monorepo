import { CallHandler, ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of } from "rxjs";
import { RequestLogInterceptor } from "./request.log.interceptor";
import { createMockLogger } from "./test/mocks";
import { FATLoggerService } from "./logger/fat.logger.provider";

const REQ_SENTINEL = "0xREQ-SENTINEL-VALUE";
const RESP_SENTINEL = "0xRESP-SENTINEL-VALUE";

function makeContext(method: string, body: unknown): ExecutionContext {
    return {
        switchToHttp: () => ({
            getRequest: () => ({
                method,
                path: "/v1/relay/evm/1/withdrawal",
                params: { chainType: "evm", chainId: "1" },
                body,
            }),
        }),
    } as unknown as ExecutionContext;
}

describe("RequestLogInterceptor (log hygiene, audit R-H4)", () => {
    let logger: ReturnType<typeof createMockLogger>;
    let interceptor: RequestLogInterceptor;

    const body = { proof: { pA: [REQ_SENTINEL] }, noteData: [REQ_SENTINEL], recipient: REQ_SENTINEL };
    const response = { txHash: RESP_SENTINEL, feeCommitment: { recipient: RESP_SENTINEL } };
    const next: CallHandler = { handle: () => of(response) };

    beforeEach(() => {
        logger = createMockLogger();
        interceptor = new RequestLogInterceptor(logger as unknown as FATLoggerService);
    });

    const serializedLogCalls = () =>
        JSON.stringify(
            [logger.log, logger.info, logger.error, logger.warn, logger.debug, logger.verbose].map((fn) => fn.mock.calls),
            (_key, value) => (typeof value === "bigint" ? value.toString() : value)
        );

    it("Never logs request bodies or response payloads for POSTs.", async () => {
        const result = await lastValueFrom(interceptor.intercept(makeContext("POST", body), next));

        expect(result).toEqual(response); // passthrough untouched
        const logs = serializedLogCalls();
        expect(logs).not.toContain(REQ_SENTINEL);
        expect(logs).not.toContain(RESP_SENTINEL);
    });

    it("Logs non-identifying request metadata and completion timing.", async () => {
        await lastValueFrom(interceptor.intercept(makeContext("POST", body), next));

        expect(logger.info).toHaveBeenCalledWith("Request received", {
            method: "POST",
            path: "/v1/relay/evm/1/withdrawal",
            params: { chainType: "evm", chainId: "1" },
        });
        expect(logger.info).toHaveBeenCalledWith("Request completed", {
            path: "/v1/relay/evm/1/withdrawal",
            durationMs: expect.any(Number),
        });
    });

    it("Passes non-POST requests through without logging.", async () => {
        const result = await lastValueFrom(interceptor.intercept(makeContext("GET", undefined), next));

        expect(result).toEqual(response);
        expect(logger.info).not.toHaveBeenCalled();
    });
});
