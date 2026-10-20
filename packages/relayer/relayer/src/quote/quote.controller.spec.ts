import { Test, TestingModule } from "@nestjs/testing";
import { mock } from "jest-mock-extended";
import { QuoteController } from "./quote.controller";
import { QUOTE_SERVICE, type IQuoteService } from "./quote.interface";
import {
    EvmTransferQuoteRequestDto,
    EvmWithdrawalQuoteRequestDto,
    EvmBatchWithdrawalQuoteRequestDto,
} from "../dto/evm.quote.dto";
import { createMockLoggerProvider } from "../test/mocks";

// Controller-layer coverage (code-review R1 TEST-1): the QuoteController had no
// spec. These verify each route forwards to the injected IQuoteService and, for
// the send/receive routes, that the exact/non-exact flag is passed correctly.

describe("QuoteController", () => {
    let controller: QuoteController;
    const quoteService = mock<IQuoteService>();

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            controllers: [QuoteController],
            // The logger mock feeds the QuoteDeadlineInterceptor attached to
            // the controller via @UseInterceptors.
            providers: [{ provide: QUOTE_SERVICE, useValue: quoteService }, createMockLoggerProvider()],
        }).compile();

        controller = await module.resolve<QuoteController>(QuoteController);
        jest.clearAllMocks();
    });

    it("delegate a transfer quote to the quote service", async () => {
        const body = { asset: "0x00", commit: false } as unknown as EvmTransferQuoteRequestDto;
        const response = { feeAmount: 1n } as never;
        quoteService.quoteTransfer.mockResolvedValue(response);

        const result = await controller.getTransferQuote(body);

        expect(quoteService.quoteTransfer).toHaveBeenCalledWith(body);
        expect(result).toBe(response);
    });

    it("call quote with NOT_EXACT for the send route", async () => {
        const body = { asset: "0x00", commit: false } as unknown as EvmWithdrawalQuoteRequestDto;
        const response = { feeAmount: 1n } as never;
        quoteService.quote.mockResolvedValue(response);

        await controller.getSendQuote(body);

        expect(quoteService.quote).toHaveBeenCalledWith(body, false);
    });

    it("call quote with IS_EXACT for the receive route", async () => {
        const body = { asset: "0x00", commit: false } as unknown as EvmWithdrawalQuoteRequestDto;
        const response = { feeAmount: 1n } as never;
        quoteService.quote.mockResolvedValue(response);

        await controller.getReceiveQuote(body);

        expect(quoteService.quote).toHaveBeenCalledWith(body, true);
    });

    it("delegate a batch quote to the quote service", async () => {
        const body = {
            asset: "0x00",
            recipient: "0x00",
            amounts: [10n, 5n],
            commit: true,
        } as unknown as EvmBatchWithdrawalQuoteRequestDto;
        const response = { totalFee: 15n } as never;
        quoteService.quoteBatch.mockResolvedValue(response);

        const result = await controller.getBatchQuote(body);

        expect(quoteService.quoteBatch).toHaveBeenCalledWith(body);
        expect(result).toBe(response);
    });
});
