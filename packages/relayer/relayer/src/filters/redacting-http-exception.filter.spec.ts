import { ArgumentsHost, BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { ZodError } from "zod";
import { ZodValidationException } from "nestjs-zod";
import { z } from "zod";
import { RedactingHttpExceptionFilter, redactResponseBody } from "./redacting-http-exception.filter";
import { createMockLogger } from "../test/mocks";
import { FATLoggerService } from "../logger/fat.logger.provider";

const KEY = "alch_SECRETKEY0123456789";
const RPC = `https://bsc-mainnet.g.alchemy.com/v2/${KEY}`;

function makeHost() {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
        switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
    return { host, status, json };
}

describe("redactResponseBody", () => {
    it("redacts a string message and an object message", () => {
        expect(redactResponseBody(`HTTP request failed.\n\nURL: ${RPC}`, 400)).toEqual({
            value: { statusCode: 400, message: "HTTP request failed." },
            changed: true,
        });
        const obj = redactResponseBody({ statusCode: 400, error: "Bad Request", message: `failed: ${RPC}` }, 400);
        expect(obj.changed).toBe(true);
        expect(JSON.stringify(obj.value)).not.toContain(KEY);
        expect((obj.value as { message: string }).message).toBe("failed: https://bsc-mainnet.<…>.alchemy.com/…");
    });

    it("redacts each entry of a message array and reports no change for clean bodies", () => {
        const arr = redactResponseBody({ statusCode: 400, message: ["ok", `bad ${RPC}`] }, 400);
        expect(arr.changed).toBe(true);
        expect((arr.value as { message: string[] }).message).toEqual(["ok", "bad https://bsc-mainnet.<…>.alchemy.com/…"]);
        const clean = redactResponseBody({ statusCode: 400, message: "Relay fee (12) exceeds withdrawal amount (10)." }, 400);
        expect(clean.changed).toBe(false);
        expect(clean.value).toEqual({ statusCode: 400, message: "Relay fee (12) exceeds withdrawal amount (10)." });
    });
});

describe("RedactingHttpExceptionFilter", () => {
    let logger: ReturnType<typeof createMockLogger>;
    let filter: RedactingHttpExceptionFilter;

    beforeEach(() => {
        logger = createMockLogger();
        filter = new RedactingHttpExceptionFilter(logger as unknown as FATLoggerService);
    });

    it("sends the redacted body with the exception's status and logs the redaction", () => {
        const { host, status, json } = makeHost();
        filter.catch(new BadRequestException(`HTTP request failed.\n\nURL: ${RPC}\nRequest body: {}`), host);
        expect(status).toHaveBeenCalledWith(400);
        const body = json.mock.calls[0][0] as { statusCode: number; message: string; error: string };
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe("Bad Request");
        expect(body.message).toBe("HTTP request failed.");
        expect(JSON.stringify(body)).not.toContain(KEY);
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("passes a clean 503 through untouched and stays quiet", () => {
        const { host, status, json } = makeHost();
        filter.catch(new ServiceUnavailableException("Relayer temporarily unavailable on chain 56."), host);
        expect(status).toHaveBeenCalledWith(503);
        expect((json.mock.calls[0][0] as { message: string }).message).toBe("Relayer temporarily unavailable on chain 56.");
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("keeps the Zod validation shape for validation failures", () => {
        const { host, status, json } = makeHost();
        const result = z.object({ amount: z.string() }).safeParse({});
        if (result.success) throw new Error("expected a validation failure");
        filter.catch(new ZodValidationException(result.error), host);
        expect(status).toHaveBeenCalledWith(400);
        expect(json.mock.calls[0][0]).toEqual({
            statusCode: 400,
            error: "Validation Error",
            message: { amount: expect.any(String) },
        });
    });
});

describe("redactResponseBody: depth and Error responses (codex + cubic on #399)", () => {
    it("normalizes an Error handed to the HttpException constructor", () => {
        const { HttpRequestError } = jest.requireActual<typeof import("viem")>("viem");
        const err = new HttpRequestError({ url: RPC, body: { method: "eth_call" }, details: "fetch failed" });
        const exception = new BadRequestException(err);
        expect(JSON.stringify(exception.getResponse())).toContain(KEY); // Nest keeps the Error as the response
        const body = redactResponseBody(exception.getResponse(), 400);
        expect(body).toEqual({ value: { statusCode: 400, message: "HTTP request failed (RPC bsc-mainnet.<…>.alchemy.com)." }, changed: true });
    });

    it("redacts strings at any depth, including fields other than message/error", () => {
        const body = redactResponseBody(
            { statusCode: 400, message: { rpc: RPC }, details: [{ url: RPC }], meta: { nested: { deep: `x ${RPC}` } } },
            400
        );
        expect(body.changed).toBe(true);
        expect(JSON.stringify(body.value)).not.toContain(KEY);
        expect(JSON.stringify(body.value)).toContain("bsc-mainnet.<…>.alchemy.com");
    });

    it("serializes class instances the way the wire would, then redacts", () => {
        class Detail {
            constructor(public readonly url: string) {}
            hidden() {
                return "not serialized";
            }
        }
        const body = redactResponseBody({ statusCode: 400, detail: new Detail(RPC), big: 10n }, 400);
        expect(body.value).toEqual({ statusCode: 400, detail: { url: "https://bsc-mainnet.<…>.alchemy.com/…" }, big: "10" });
    });
});

describe("round 3: serialization guard, key names, non-Nest errors (codex on #399)", () => {
    let logger: ReturnType<typeof createMockLogger>;
    let filter: RedactingHttpExceptionFilter;

    beforeEach(() => {
        logger = createMockLogger();
        filter = new RedactingHttpExceptionFilter(logger as unknown as FATLoggerService);
    });

    it("keeps the 400 when the body cannot be serialized", () => {
        const { host, status, json } = makeHost();
        const body: Record<string, unknown> = { message: `bad ${RPC}` };
        body.self = body;
        filter.catch(new BadRequestException(body), host);
        expect(status).toHaveBeenCalledWith(400);
        const sent = json.mock.calls[0][0] as { statusCode: number; message: string };
        expect(sent.statusCode).toBe(400);
        expect(JSON.stringify(sent)).not.toContain(KEY);
    });

    it("redacts a URL used as a property name", () => {
        const body = redactResponseBody({ statusCode: 400, [RPC]: "upstream" }, 400);
        expect(body.changed).toBe(true);
        expect(JSON.stringify(body.value)).not.toContain(KEY);
        expect(Object.keys(body.value as object)).toContain("https://bsc-mainnet.<…>.alchemy.com/…");
    });

    it("answers an http-errors-shaped Error with its status and a redacted message", () => {
        const { host, status, json } = makeHost();
        const err = Object.assign(new Error(`upstream ${RPC} failed`), { statusCode: 400 });
        filter.catch(err, host);
        expect(status).toHaveBeenCalledWith(400);
        expect(json.mock.calls[0][0]).toEqual({ statusCode: 400, message: "upstream https://bsc-mainnet.<…>.alchemy.com/… failed" });
    });

    it("answers any other error with the generic 500", () => {
        const { host, status, json } = makeHost();
        filter.catch(new Error(`boom ${RPC}`), host);
        expect(status).toHaveBeenCalledWith(500);
        expect(json.mock.calls[0][0]).toEqual({ statusCode: 500, message: "Internal server error" });
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("redacts a Zod message too, for both exception forms", () => {
        const { host, json } = makeHost();
        const result = z.object({ amount: z.string().refine(() => false, { message: `upstream ${RPC} failed` }) }).safeParse({ amount: "1" });
        if (result.success) throw new Error("expected a validation failure");
        filter.catch(new ZodValidationException(result.error), host);
        expect(json.mock.calls[0][0]).toEqual({ statusCode: 400, error: "Validation Error", message: { amount: "upstream https://bsc-mainnet.<…>.alchemy.com/… failed" } });
        const bare = makeHost();
        filter.catch(result.error as ZodError, bare.host);
        expect(JSON.stringify(bare.json.mock.calls[0][0])).not.toContain(KEY);
    });
});

describe("round 4: nested errors, plain http-shaped objects, headersSent, Zod path keys", () => {
    let logger: ReturnType<typeof createMockLogger>;
    let filter: RedactingHttpExceptionFilter;

    beforeEach(() => {
        logger = createMockLogger();
        filter = new RedactingHttpExceptionFilter(logger as unknown as FATLoggerService);
    });

    it("normalizes an Error nested inside the body before JSON erases its type", () => {
        const { RpcRequestError } = jest.requireActual<typeof import("viem")>("viem");
        const err = new RpcRequestError({ body: { method: "eth_call" }, url: RPC, error: { code: -32005, message: `rate limit exceeded for API key ${KEY}` } });
        const body = redactResponseBody({ statusCode: 400, details: err, list: [err] }, 400);
        expect(JSON.stringify(body.value)).not.toContain(KEY);
        expect((body.value as { details: string }).details).toBe("RPC request failed: rate limited.");
    });

    it("answers a plain http-errors-shaped object with its status", () => {
        const { host, status, json } = makeHost();
        filter.catch({ statusCode: 418, message: `teapot ${RPC}` }, host);
        expect(status).toHaveBeenCalledWith(418);
        expect(json.mock.calls[0][0]).toEqual({ statusCode: 418, message: "teapot https://bsc-mainnet.<…>.alchemy.com/…" });
    });

    it("ends a response that already started instead of writing JSON over it", () => {
        const end = jest.fn();
        const json = jest.fn();
        const host = { switchToHttp: () => ({ getResponse: () => ({ headersSent: true, end, status: () => ({ json }) }) }) } as unknown as ArgumentsHost;
        filter.catch(new BadRequestException("late"), host);
        expect(end).toHaveBeenCalledTimes(1);
        expect(json).not.toHaveBeenCalled();
    });

    it("redacts a Zod issue path used as a response key", () => {
        const { host, json } = makeHost();
        const err = new ZodError([{ code: "custom", path: [RPC], message: "bad" }]);
        filter.catch(err, host);
        const sent = json.mock.calls[0][0] as { message: Record<string, string> };
        expect(JSON.stringify(sent)).not.toContain(KEY);
        expect(Object.keys(sent.message)).toEqual(["https://bsc-mainnet.<…>.alchemy.com/…"]);
    });

    it("leaves prototype-named keys alone and reports no change", () => {
        const body = redactResponseBody({ statusCode: 400, constructor: "x", toString: "y", message: "clean" }, 400);
        expect(body.changed).toBe(false);
        expect(body.value).toEqual({ statusCode: 400, constructor: "x", toString: "y", message: "clean" });
    });
});

describe("round 5: aliases, class instances, toJSON, headersSent before Zod, __proto__ keys", () => {
    it("normalizes an aliased nested error everywhere it appears", () => {
        const { RpcRequestError } = jest.requireActual<typeof import("viem")>("viem");
        const err = new RpcRequestError({ body: { method: "eth_call" }, url: RPC, error: { code: -32005, message: `rate limit exceeded for API key ${KEY}` } });
        const shared = { err };
        class Holder {
            constructor(public readonly inner: unknown) {}
        }
        const body = redactResponseBody({ statusCode: 400, first: shared, second: shared, holder: new Holder(err), viaJson: { toJSON: () => ({ err }) } }, 400);
        const text = JSON.stringify(body.value);
        expect(text).not.toContain(KEY);
        expect(text).not.toContain("API key");
        expect((body.value as { second: { err: string } }).second.err).toBe("RPC request failed: rate limited.");
        expect((body.value as { holder: { inner: string } }).holder.inner).toBe("RPC request failed: rate limited.");
        expect((body.value as { viaJson: { err: string } }).viaJson.err).toBe("RPC request failed: rate limited.");
    });

    it("ends an already-started response even for a Zod failure", () => {
        const end = jest.fn();
        const json = jest.fn();
        const host = { switchToHttp: () => ({ getResponse: () => ({ headersSent: true, end, status: () => ({ json }) }) }) } as unknown as ArgumentsHost;
        const filter = new RedactingHttpExceptionFilter(createMockLogger() as unknown as FATLoggerService);
        filter.catch(new ZodError([{ code: "custom", path: ["amount"], message: "bad" }]), host);
        expect(end).toHaveBeenCalledTimes(1);
        expect(json).not.toHaveBeenCalled();
    });

    it("keeps a __proto__ key as data", () => {
        const body = redactResponseBody(JSON.parse('{"__proto__":"x","constructor":"y","message":"clean"}'), 400);
        expect(body.changed).toBe(false);
        expect(JSON.stringify(body.value)).toBe('{"__proto__":"x","constructor":"y","message":"clean"}');
    });
});
