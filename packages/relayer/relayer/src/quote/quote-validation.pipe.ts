import { Inject, Injectable, PipeTransform, Scope } from "@nestjs/common";
import { QUOTE_SERVICE, type IQuoteService } from "./quote.interface";

@Injectable({ scope: Scope.REQUEST })
export class QuoteValidationPipe implements PipeTransform {
    constructor(@Inject(QUOTE_SERVICE) private readonly quoteService: IQuoteService) {}

    transform(value: unknown) {
        return this.quoteService.schema.parse(value);
    }
}

@Injectable({ scope: Scope.REQUEST })
export class BatchQuoteValidationPipe implements PipeTransform {
    constructor(@Inject(QUOTE_SERVICE) private readonly quoteService: IQuoteService) {}

    transform(value: unknown) {
        return this.quoteService.batchSchema.parse(value);
    }
}

// Swap-quote requests hit a bare @Body() without this pipe, so the schema's
// superRefine guards (calldata/target on commit, extraGas off when recipient is
// zero, hex/type checks) never ran and raw JSON reached the service. Parse here
// so nativeGas arrives as a validated bigint before the quoteSwap bounding logic.
@Injectable({ scope: Scope.REQUEST })
export class SwapQuoteValidationPipe implements PipeTransform {
    constructor(@Inject(QUOTE_SERVICE) private readonly quoteService: IQuoteService) {}

    transform(value: unknown) {
        if (!this.quoteService.swapSchema) {
            throw new Error("Swap quotes not supported on this chain type");
        }
        return this.quoteService.swapSchema.parse(value);
    }
}

@Injectable({ scope: Scope.REQUEST })
export class TransferQuoteValidationPipe implements PipeTransform {
    constructor(@Inject(QUOTE_SERVICE) private readonly quoteService: IQuoteService) {}

    transform(value: unknown) {
        return this.quoteService.transferSchema.parse(value);
    }
}
