import { Injectable, Inject, BadRequestException } from "@nestjs/common";
import { clientSafeErrorMessage } from "../errors/redact";
import type { ChainType } from "../config/enums";
import type { Quote, RateGetterFunction, RateProviderDescription, TokenDescription } from "./rate_types";
import { FATLoggerService } from "../logger/fat.logger.provider";

@Injectable()
export class RateProviderService {
    constructor(
        private readonly logger: FATLoggerService,
        @Inject("RATE_GETTER_FUNCTION") private readonly getRate: RateGetterFunction,
        @Inject("RATE_PROVIDER_DESCRIPTION")
        private readonly description: RateProviderDescription
    ) {}

    // Exposed so the boot-time validator (rate_provider_boot_validator.ts) can read a
    // discovered provider's declared chain support without duplicating this DI wiring.
    getDescription(): RateProviderDescription {
        return this.description;
    }

    // Defense-in-depth only: the boot validator already checks every configured asset's
    // (chainType, chainId) against this same description, so this should be unreachable
    // in practice. It's not a bad client request if it ever fires — it's an internal
    // wiring inconsistency — hence a plain Error rather than BadRequestException.
    private assertSupportsChain(chainType: ChainType, chainId: number): void {
        const supported = this.description.known_currencies.some(
            (currency) => currency.chainType === chainType && currency.chainId === chainId
        );
        if (!supported) {
            const message = `Rate provider ${this.description.provider} does not support chainType=${chainType} chainId=${chainId}`;
            this.logger.error(message);
            throw new Error(message);
        }
    }

    async quote(
        input_token: TokenDescription,
        output_token: TokenDescription,
        chainType: ChainType,
        chainId: number,
        rpc_url: string,
    ): Promise<Quote> {
        this.assertSupportsChain(chainType, chainId);
        try {
            return await this.getRate(input_token, output_token, chainType, chainId, rpc_url);
        } catch (err) {
            // Previously uncaught here: propagated as a bare Error through quoteInNativeToken
            // with no logging and no HTTP-semantic wrapping, surfacing to callers as an opaque
            // 500 via Nest's default filter. Whatever the specific cause (unpriced asset,
            // degenerate zero rate, unsupported chain), it means this request can't be quoted
            // as configured right now — a client-facing 400, not a server bug.
            const message = err instanceof Error ? err.message : String(err);
            // Upstream/config fault (CLAUDE.md §4b): page once per provider and chain, never per token or message.
            this.logger.error(`Rate provider ${this.description.provider} failed to quote ${input_token.ticker}: ${message}`, {
                alert: true,
                dedupKey: `quote.rateProvider.${this.description.provider}.${chainId}`,
            });
            // The client gets the one-line, key-free form: a viem transport error
            // carries the RPC URL (and its API key) in its message.
            throw new BadRequestException(clientSafeErrorMessage(err));
        }
    }
}
