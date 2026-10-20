import { Injectable, NotImplementedException } from "@nestjs/common";
import { ChainedQuoteService } from "../quote.interface";
import { ChainType } from "../../config/enums";
import { zStarknetQuoteRequest, StarknetQuoteRequest } from "./starknet.schemas";
import { StarknetQuoteResponse } from "./types";
import { FATLoggerService } from "../../logger/fat.logger.provider";

@Injectable()
export class StarknetQuoteService implements ChainedQuoteService<ChainType.STARKNET> {
    schema = zStarknetQuoteRequest;
    transferSchema = zStarknetQuoteRequest;
    batchSchema = zStarknetQuoteRequest;

    constructor(private readonly logger: FATLoggerService) {}

    async quote(_request: StarknetQuoteRequest, _exact: boolean): Promise<StarknetQuoteResponse> {
        this.logger.warn("Starknet quote not implemented");
        throw new NotImplementedException("Starknet quote not implemented");
    }

    async quoteTransfer(_request: StarknetQuoteRequest): Promise<StarknetQuoteResponse> {
        this.logger.warn("Starknet quoteTransfer not implemented");
        throw new NotImplementedException("Starknet quoteTransfer not implemented");
    }

    async quoteBatch(_request: StarknetQuoteRequest): Promise<StarknetQuoteResponse> {
        this.logger.warn("Starknet quoteBatch not implemented");
        throw new NotImplementedException("Starknet quoteBatch not implemented");
    }
}
