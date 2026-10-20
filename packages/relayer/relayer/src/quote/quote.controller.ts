import { Body, Controller, Inject, Post, UseInterceptors } from "@nestjs/common";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { QUOTE_SERVICE, type IQuoteService } from "./quote.interface";
import { QuoteDeadlineInterceptor } from "./quote-deadline.interceptor";
import { QuoteValidationPipe, BatchQuoteValidationPipe, SwapQuoteValidationPipe, TransferQuoteValidationPipe } from "./quote-validation.pipe";
import { ApiBody, ApiExtraModels, ApiOkResponse, ApiOperation, getSchemaPath } from "@nestjs/swagger";
import {
    EvmTransferQuoteRequestDto,
    EvmTransferQuoteResponseDto,
    EvmWithdrawalQuoteRequestDto,
    EvmWithdrawalQuoteResponseDto,
    EvmBatchWithdrawalQuoteRequestDto,
    EvmBatchWithdrawalQuoteResponseDto,
    EvmSwapQuoteRequestDto,
    EvmSwapQuoteResponseDto,
} from "../dto/evm.quote.dto";
import {
    StarknetTransferQuoteRequestDto,
    StarknetTransferQuoteResponseDto,
    StarknetWithdrawalQuoteRequestDto,
    StarknetWithdrawalQuoteResponseDto,
} from "../dto/starknet.quote.dto";
import { StellarWithdrawalQuoteRequestDto, StellarWithdrawalQuoteResponseDto } from "../dto/stellar.quote.dto";

const IS_EXACT = true;
const NOT_EXACT = false;

@ApiExtraModels(
    EvmWithdrawalQuoteRequestDto,
    EvmWithdrawalQuoteResponseDto,
    EvmTransferQuoteRequestDto,
    EvmTransferQuoteResponseDto,
    EvmBatchWithdrawalQuoteRequestDto,
    EvmBatchWithdrawalQuoteResponseDto,
    EvmSwapQuoteRequestDto,
    EvmSwapQuoteResponseDto,
    StarknetWithdrawalQuoteRequestDto,
    StarknetWithdrawalQuoteResponseDto,
    StarknetTransferQuoteRequestDto,
    StarknetTransferQuoteResponseDto,
    StellarWithdrawalQuoteRequestDto,
    StellarWithdrawalQuoteResponseDto,
)
@Controller("quote/:chainType/:chainId")
// A globally-registered ThrottlerGuard (app.module.ts) checks a route against every
// configured throttle profile, not just the one it opts into via @Throttle -- without this,
// quote routes were also being checked against (and exhausted by) the much stricter "relay"
// profile (5/60s) instead of only their own "quote" profile (20/60s). See commit c5efc0e7,
// which added per-route-class throttling with no stated intent for routes to share limits.
@SkipThrottle({ relay: true })
@UseInterceptors(QuoteDeadlineInterceptor)
export class QuoteController {
    constructor(@Inject(QUOTE_SERVICE) private readonly quoteService: IQuoteService) {}

    @Post("transfer")
    @Throttle({ quote: {} })
    @ApiOperation({ summary: "Get a quote for an internal transfer" })
    @ApiBody({
        schema: {
            oneOf: [
                { $ref: getSchemaPath(EvmTransferQuoteRequestDto) },
                { $ref: getSchemaPath(StarknetTransferQuoteRequestDto) },
            ],
        },
    })
    @ApiOkResponse({
        schema: {
            oneOf: [
                { $ref: getSchemaPath(EvmTransferQuoteResponseDto) },
                { $ref: getSchemaPath(StarknetTransferQuoteResponseDto) },
            ],
        },
    })
    async getTransferQuote(@Body(TransferQuoteValidationPipe) body: EvmTransferQuoteRequestDto) {
        return this.quoteService.quoteTransfer(body);
    }

    @Post("send")
    @Throttle({ quote: {} })
    @ApiOperation({
        summary: "Get a quote for a withdrawal quote, where the fee amount is contained in the withdrawal amount",
    })
    @ApiBody({
        schema: {
            oneOf: [
                { $ref: getSchemaPath(EvmWithdrawalQuoteRequestDto) },
                { $ref: getSchemaPath(StarknetWithdrawalQuoteRequestDto) },
                { $ref: getSchemaPath(StellarWithdrawalQuoteRequestDto) },
            ],
        },
    })
    @ApiOkResponse({
        schema: {
            oneOf: [
                { $ref: getSchemaPath(EvmWithdrawalQuoteResponseDto) },
                { $ref: getSchemaPath(StarknetWithdrawalQuoteResponseDto) },
                { $ref: getSchemaPath(StellarWithdrawalQuoteResponseDto) },
            ],
        },
    })
    async getSendQuote(@Body(QuoteValidationPipe) body: EvmWithdrawalQuoteRequestDto) {
        return this.quoteService.quote(body, NOT_EXACT);
    }

    @Post("receive")
    @Throttle({ quote: {} })
    @ApiOperation({
        summary: "Get a quote for a withdrawal quote, where the fee amount is added on top of the withdrawal amount",
    })
    @ApiBody({
        schema: {
            oneOf: [
                { $ref: getSchemaPath(EvmWithdrawalQuoteRequestDto) },
                { $ref: getSchemaPath(StarknetWithdrawalQuoteRequestDto) },
                { $ref: getSchemaPath(StellarWithdrawalQuoteRequestDto) },
            ],
        },
    })
    @ApiOkResponse({
        schema: {
            oneOf: [
                { $ref: getSchemaPath(EvmWithdrawalQuoteResponseDto) },
                { $ref: getSchemaPath(StarknetWithdrawalQuoteResponseDto) },
                { $ref: getSchemaPath(StellarWithdrawalQuoteResponseDto) },
            ],
        },
    })
    async getReceiveQuote(@Body(QuoteValidationPipe) body: EvmWithdrawalQuoteRequestDto) {
        return this.quoteService.quote(body, IS_EXACT);
    }

    @Post("batch")
    @Throttle({ quote: {} })
    @ApiOperation({
        summary:
            "Get one aggregate fee quote for a batch withdrawal. Returns a single signed batch fee commitment whose data ABI-encodes the per-item PayoutRouting[].",
    })
    @ApiBody({ schema: { $ref: getSchemaPath(EvmBatchWithdrawalQuoteRequestDto) } })
    @ApiOkResponse({ schema: { $ref: getSchemaPath(EvmBatchWithdrawalQuoteResponseDto) } })
    async getBatchQuote(@Body(BatchQuoteValidationPipe) body: EvmBatchWithdrawalQuoteRequestDto) {
        return this.quoteService.quoteBatch(body);
    }

    @Post("swap")
    @Throttle({ quote: {} })
    @ApiOperation({ summary: "Get a fee quote for a withdraw + swap operation" })
    @ApiBody({ schema: { $ref: getSchemaPath(EvmSwapQuoteRequestDto) } })
    @ApiOkResponse({ schema: { $ref: getSchemaPath(EvmSwapQuoteResponseDto) } })
    async getSwapQuote(@Body(SwapQuoteValidationPipe) body: EvmSwapQuoteRequestDto) {
        if (!this.quoteService.quoteSwap) {
            throw new Error("Swap quotes not supported on this chain type");
        }
        return this.quoteService.quoteSwap(body);
    }
}
