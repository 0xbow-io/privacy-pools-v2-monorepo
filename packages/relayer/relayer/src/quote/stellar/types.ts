import { z } from "zod";
import {
    zStellarQuoteRequest,
    zStellarQuoteResponse,
    zStellarWithdrawalFeeCommitment,
    zStellarSignedWithdrawalFeeCommitment,
    zStellarBatchQuoteRequest,
    zStellarBatchQuoteResponse,
    zStellarBatchFeeCommitment,
    zStellarSignedBatchFeeCommitment,
    zStellarTransferQuoteRequest,
    zStellarTransferQuoteResponse,
    zStellarTransferFeeCommitment,
    zStellarSignedTransferFeeCommitment,
} from "./schemas";

export type StellarQuoteRequest = z.infer<typeof zStellarQuoteRequest>;
export type StellarQuoteResponse = z.infer<typeof zStellarQuoteResponse>;
export type StellarWithdrawalFeeCommitment = z.infer<typeof zStellarWithdrawalFeeCommitment>;
export type StellarSignedWithdrawalFeeCommitment = z.infer<typeof zStellarSignedWithdrawalFeeCommitment>;
export type StellarBatchQuoteRequest = z.infer<typeof zStellarBatchQuoteRequest>;
export type StellarBatchQuoteResponse = z.infer<typeof zStellarBatchQuoteResponse>;
export type StellarBatchFeeCommitment = z.infer<typeof zStellarBatchFeeCommitment>;
export type StellarSignedBatchFeeCommitment = z.infer<typeof zStellarSignedBatchFeeCommitment>;
export type StellarTransferQuoteRequest = z.infer<typeof zStellarTransferQuoteRequest>;
export type StellarTransferQuoteResponse = z.infer<typeof zStellarTransferQuoteResponse>;
export type StellarTransferFeeCommitment = z.infer<typeof zStellarTransferFeeCommitment>;
export type StellarSignedTransferFeeCommitment = z.infer<typeof zStellarSignedTransferFeeCommitment>;
