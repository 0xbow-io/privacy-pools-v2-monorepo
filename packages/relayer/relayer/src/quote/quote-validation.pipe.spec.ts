import { Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { mock } from "jest-mock-extended";
import { z } from "zod";
import {
    QuoteValidationPipe,
    BatchQuoteValidationPipe,
    SwapQuoteValidationPipe,
    TransferQuoteValidationPipe,
} from "./quote-validation.pipe";
import { QUOTE_SERVICE, type IQuoteService } from "./quote.interface";

// Regression coverage mirroring relay/relay-validation.pipe.spec.ts: BatchQuoteValidationPipe,
// SwapQuoteValidationPipe and TransferQuoteValidationPipe used to hardcode EVM zod schemas
// regardless of which chain QUOTE_SERVICE actually resolved to. QuoteValidationPipe (the
// withdrawal-quote pipe) was already chain-aware before this fix — included here for parity.
const NOT_EVM_SCHEMA = z.object({ marker: z.literal("not-evm") });
const VALID_BODY = { marker: "not-evm" };

async function resolvePipe<T>(pipeClass: Type<T>, quoteService: IQuoteService): Promise<T> {
    const module = await Test.createTestingModule({
        providers: [pipeClass, { provide: QUOTE_SERVICE, useValue: quoteService }],
    }).compile();
    return module.resolve(pipeClass);
}

describe("quote validation pipes", () => {
    it("QuoteValidationPipe delegates to the resolved service's schema", async () => {
        const quoteService = mock<IQuoteService>();
        quoteService.schema = NOT_EVM_SCHEMA;
        const pipe = await resolvePipe(QuoteValidationPipe, quoteService);

        expect(pipe.transform(VALID_BODY)).toEqual(VALID_BODY);
        expect(() => pipe.transform({})).toThrow();
    });

    it("BatchQuoteValidationPipe delegates to the resolved service's batchSchema", async () => {
        const quoteService = mock<IQuoteService>();
        quoteService.batchSchema = NOT_EVM_SCHEMA;
        const pipe = await resolvePipe(BatchQuoteValidationPipe, quoteService);

        expect(pipe.transform(VALID_BODY)).toEqual(VALID_BODY);
        expect(() => pipe.transform({})).toThrow();
    });

    it("TransferQuoteValidationPipe delegates to the resolved service's transferSchema", async () => {
        const quoteService = mock<IQuoteService>();
        quoteService.transferSchema = NOT_EVM_SCHEMA;
        const pipe = await resolvePipe(TransferQuoteValidationPipe, quoteService);

        expect(pipe.transform(VALID_BODY)).toEqual(VALID_BODY);
        expect(() => pipe.transform({})).toThrow();
    });

    it("SwapQuoteValidationPipe delegates to the resolved service's swapSchema", async () => {
        const quoteService = mock<IQuoteService>();
        quoteService.swapSchema = NOT_EVM_SCHEMA;
        const pipe = await resolvePipe(SwapQuoteValidationPipe, quoteService);

        expect(pipe.transform(VALID_BODY)).toEqual(VALID_BODY);
        expect(() => pipe.transform({})).toThrow();
    });

    it("SwapQuoteValidationPipe throws when the resolved service has no swapSchema (e.g. Starknet)", async () => {
        const quoteService = mock<IQuoteService>();
        quoteService.swapSchema = undefined;
        const pipe = await resolvePipe(SwapQuoteValidationPipe, quoteService);

        expect(() => pipe.transform(VALID_BODY)).toThrow("Swap quotes not supported on this chain type");
    });
});
