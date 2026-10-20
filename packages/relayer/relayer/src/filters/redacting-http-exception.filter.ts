import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Optional } from "@nestjs/common";
import { Response } from "express";
import { ZodValidationException } from "nestjs-zod";
import { ZodError } from "zod";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { RelayerConfig } from "../config/relayer-config";
import { EvmChainConfigWrapper } from "../config/evm/evm-chain-config";
import { StellarChainConfigWrapper } from "../config/stellar/stellar-chain-config";
import { ChainType } from "../config/enums";
import { clientSafeErrorMessage, redactText, registerKnownSecrets } from "../errors/redact";
import { ZodValidationFilter } from "./zod-validation.filter";

/// Last line of defense for response hygiene, on EVERY exception:
///   - HttpException: whatever it carries (a viem error re-thrown as
///     BadRequestException, a chain-service "<action> failed: <msg>", an Error
///     object handed to the constructor, an Error nested in the body) leaves
///     with URLs reduced to their public label, known endpoint secrets scrubbed
///     and viem's verbose sections removed, at every depth of the body, keys
///     included;
///   - Zod validation failures keep their dedicated shape (also redacted);
///   - an http-errors-shaped value (integer 4xx/5xx `statusCode` + string
///     message), which Nest's base filter would forward verbatim, is answered
///     with its status and a redacted message;
///   - anything else is the generic 500 Nest would have sent, logged here.
/// Provider API keys live in RPC URLs, and one reached a prod quote response
/// (2026-09-07). The full text stays in the server log.
@Catch()
export class RedactingHttpExceptionFilter implements ExceptionFilter {
    private readonly zodFilter: ZodValidationFilter;

    constructor(
        private readonly logger: FATLoggerService,
        @Optional() relayerConfig?: RelayerConfig
    ) {
        this.zodFilter = new ZodValidationFilter(logger);
        if (relayerConfig) {
            // The configured RPC endpoints are the secrets this service holds:
            // register them once so every redaction scrubs them, whatever the
            // upstream text looked like.
            const evm = relayerConfig.chain(ChainType.EVM);
            const evmRpcUrls = evm.exists() ? evm.allConfigs().map((c) => new EvmChainConfigWrapper(c).rpcUrl()) : [];
            const stellar = relayerConfig.chain(ChainType.STELLAR);
            const stellarRpcUrls = stellar.exists()
                ? stellar.allConfigs().map((c) => new StellarChainConfigWrapper(c).rpcUrl())
                : [];
            registerKnownSecrets([...evmRpcUrls, ...stellarRpcUrls]);
        }
    }

    catch(exception: unknown, host: ArgumentsHost) {
        const response = host.switchToHttp().getResponse<Response>();
        if (response.headersSent) {
            // A handler already started writing: nothing sane to add.
            response.end();
            return;
        }
        if (exception instanceof ZodValidationException || exception instanceof ZodError) {
            this.zodFilter.catch(exception, host);
            return;
        }
        if (exception instanceof HttpException) {
            const status = exception.getStatus();
            const body = redactResponseBody(exception.getResponse(), status, exception.message);
            if (body.changed) {
                this.logger.warn("Redacted an error response", { status, original: describeForLog(exception.getResponse()) });
            }
            response.status(status).json(body.value);
            return;
        }
        const httpShaped = asHttpErrorShape(exception);
        if (httpShaped) {
            this.logger.warn("Redacted an http-error-shaped exception", { status: httpShaped.statusCode, original: httpShaped.message });
            response.status(httpShaped.statusCode).json({ statusCode: httpShaped.statusCode, message: redactText(httpShaped.message) });
            return;
        }
        this.logger.error("Unhandled exception", describeForLog(exception));
        response.status(500).json({ statusCode: 500, message: "Internal server error" });
    }
}

/// Pure: the JSON Nest would have sent, redacted. Exported for the spec.
///   - an Error handed to the HttpException constructor is kept by Nest AS the
///     response (its enumerable fields, e.g. viem's `url`, would be serialized;
///     its message would not): it becomes { statusCode, message } from
///     clientSafeErrorMessage;
///   - a string becomes { statusCode, message };
///   - any other value: Error instances at any depth become their safe message
///     first (JSON would erase their type and keep their enumerable fields),
///     then the value is reduced to what the wire would carry (JSON) and every
///     string in it, keys included, is redacted;
///   - a body that cannot be serialized (cycle, throwing getter) keeps the
///     status and falls back to the exception's own (redacted) message: an
///     intended 400 must not turn into a 500 here.
export function redactResponseBody(raw: unknown, status: number, fallbackMessage = "Request failed"): { value: unknown; changed: boolean } {
    if (raw instanceof Error) {
        return { value: { statusCode: status, message: clientSafeErrorMessage(raw) }, changed: true };
    }
    if (typeof raw === "string") {
        const message = redactText(raw);
        return { value: { statusCode: status, message }, changed: message !== raw };
    }
    try {
        const normalized = replaceNestedErrors(raw, new WeakMap());
        const wire = toWire(normalized.value);
        if (wire === undefined) throw new Error("not serializable");
        const redacted = redactDeep(wire);
        return { value: redacted.value, changed: redacted.changed || normalized.changed };
    } catch {
        return { value: { statusCode: status, message: redactText(fallbackMessage) }, changed: true };
    }
}

interface Normalized {
    value: unknown;
    changed: boolean;
}

/// Errors anywhere in the body (plain objects, arrays, class instances, the
/// result of a toJSON) become their safe message BEFORE JSON erases their type
/// and keeps their enumerable fields. Memoised per object so an aliased
/// reference is normalised once and the same way; a cycle resolves to the
/// original object, which toWire then rejects (the caller falls back to a
/// static body).
function replaceNestedErrors(value: unknown, memo: WeakMap<object, Normalized>): Normalized {
    if (value instanceof Error) return { value: clientSafeErrorMessage(value), changed: true };
    if (value === null || typeof value !== "object") return { value, changed: false };
    const done = memo.get(value);
    if (done) return done;
    memo.set(value, { value, changed: false });
    const withToJson = value as { toJSON?: unknown };
    let result: Normalized;
    if (typeof withToJson.toJSON === "function") {
        result = replaceNestedErrors((withToJson.toJSON as () => unknown).call(value), memo);
    } else if (Array.isArray(value)) {
        let changed = false;
        const next = value.map((item) => {
            const r = replaceNestedErrors(item, memo);
            changed = changed || r.changed;
            return r.value;
        });
        result = { value: next, changed };
    } else {
        let changed = false;
        const next: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [key, item] of Object.entries(value)) {
            const r = replaceNestedErrors(item, memo);
            changed = changed || r.changed;
            next[key] = r.value;
        }
        result = { value: next, changed };
    }
    memo.set(value, result);
    return result;
}

function toWire(value: unknown): unknown {
    const json = JSON.stringify(value ?? null, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    return json === undefined ? undefined : JSON.parse(json);
}

function redactDeep(value: unknown): Normalized {
    if (typeof value === "string") {
        const next = redactText(value);
        return { value: next, changed: next !== value };
    }
    if (Array.isArray(value)) {
        let changed = false;
        const next = value.map((item) => {
            const r = redactDeep(item);
            changed = changed || r.changed;
            return r.value;
        });
        return { value: next, changed };
    }
    if (value !== null && typeof value === "object") {
        let changed = false;
        // Null prototype: `constructor`/`toString`/`__proto__` are ordinary keys here.
        const next: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [key, item] of Object.entries(value)) {
            const r = redactDeep(item);
            // Property names are strings on the wire too (a URL used as a key).
            let safeKey = redactText(key);
            if (safeKey !== key) changed = true;
            while (Object.prototype.hasOwnProperty.call(next, safeKey)) {
                safeKey += "_";
                changed = true;
            }
            changed = changed || r.changed;
            next[safeKey] = r.value;
        }
        return { value: next, changed };
    }
    return { value, changed: false };
}

/// A thrown value that is not a Nest HttpException but carries an HTTP status
/// the way `http-errors` objects do (an Error or a plain object). Nest's base
/// filter forwards those verbatim.
function asHttpErrorShape(exception: unknown): { statusCode: number; message: string } | undefined {
    if (exception === null || typeof exception !== "object") return undefined;
    const { statusCode, message } = exception as { statusCode?: unknown; message?: unknown };
    if (typeof statusCode !== "number" || !Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) return undefined;
    if (typeof message !== "string") return undefined;
    return { statusCode, message };
}

function describeForLog(raw: unknown): unknown {
    if (raw instanceof Error) return { name: raw.name, message: raw.message };
    try {
        return toWire(raw);
    } catch {
        return { unserializable: true };
    }
}
