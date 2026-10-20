import { z } from "zod";
import { ChainType } from "../config/enums";
import {
    EvmTransferQuoteResponse,
    EvmWithdrawalQuoteResponse,
    EvmBatchWithdrawalQuoteResponse,
    EvmSwapQuoteResponse,
} from "./evm/types";
import {
    EvmTransferQuoteRequestDto,
    EvmWithdrawalQuoteRequestDto,
    EvmBatchWithdrawalQuoteRequestDto,
    EvmSwapQuoteRequestDto,
} from "../dto/evm.quote.dto";
import { StarknetQuoteRequest } from "./starknet/starknet.schemas";
import { StarknetQuoteResponse } from "./starknet/types";
import {
    StellarBatchQuoteRequest,
    StellarBatchQuoteResponse,
    StellarQuoteRequest,
    StellarQuoteResponse,
    StellarTransferQuoteRequest,
    StellarTransferQuoteResponse,
} from "./stellar/types";

export interface EvmQuoteTypes {
    withdrawalRequest: EvmWithdrawalQuoteRequestDto;
    withdrawalResponse: EvmWithdrawalQuoteResponse;
    transferRequest: EvmTransferQuoteRequestDto;
    transferResponse: EvmTransferQuoteResponse;
    batchRequest: EvmBatchWithdrawalQuoteRequestDto;
    batchResponse: EvmBatchWithdrawalQuoteResponse;
    swapRequest: EvmSwapQuoteRequestDto;
    swapResponse: EvmSwapQuoteResponse;
}

export interface StarknetQuoteTypes {
    withdrawalRequest: StarknetQuoteRequest;
    withdrawalResponse: StarknetQuoteResponse;
    transferRequest: StarknetQuoteRequest;
    transferResponse: StarknetQuoteResponse;
    batchRequest: StarknetQuoteRequest;
    batchResponse: StarknetQuoteResponse;
    swapRequest: never;
    swapResponse: never;
}

export interface StellarQuoteTypes {
    withdrawalRequest: StellarQuoteRequest;
    withdrawalResponse: StellarQuoteResponse;
    transferRequest: StellarTransferQuoteRequest;
    transferResponse: StellarTransferQuoteResponse;
    batchRequest: StellarBatchQuoteRequest;
    batchResponse: StellarBatchQuoteResponse;
    swapRequest: never;
    swapResponse: never;
}

export interface QuoteTypes {
    [ChainType.EVM]: EvmQuoteTypes;
    [ChainType.STARKNET]: StarknetQuoteTypes;
    [ChainType.SOLANA]: StarknetQuoteTypes; // TODO: replace when Solana is implemented
    [ChainType.STELLAR]: StellarQuoteTypes;
}

export interface IQuoteService<T extends QuoteTypes[ChainType] = QuoteTypes[ChainType]> {
    // Withdrawal-quote request schema. Per-chain, resolved via QUOTE_SERVICE so
    // QuoteValidationPipe validates against the right chain's shape (quote-validation.pipe.ts).
    schema: z.ZodType<unknown, z.ZodTypeDef, unknown>;
    transferSchema: z.ZodType<unknown, z.ZodTypeDef, unknown>;
    batchSchema: z.ZodType<unknown, z.ZodTypeDef, unknown>;
    swapSchema?: z.ZodType<unknown, z.ZodTypeDef, unknown>;
    quote(request: T["withdrawalRequest"], exact: boolean): Promise<T["withdrawalResponse"]>;
    quoteTransfer(request: T["transferRequest"]): Promise<T["transferResponse"]>;
    quoteBatch(request: T["batchRequest"]): Promise<T["batchResponse"]>;
    quoteSwap?(request: T["swapRequest"]): Promise<T["swapResponse"]>;
}

export type ChainedQuoteService<TChainType extends ChainType> = IQuoteService<QuoteTypes[TChainType]>;

// injection token for NestJS DI
export const QUOTE_SERVICE = Symbol("QUOTE_SERVICE");
