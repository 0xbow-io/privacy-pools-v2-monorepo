import { z } from "zod";
import {
    zBaseFeeCommitment,
    zTransferFeeCommitment,
    zWithdrawalFeeCommitment,
    zSwapFeeCommitment,
    zSignedTransferFeeCommitment,
    zSignedWithdrawalFeeCommitment,
    zBatchWithdrawalFeeCommitment,
    zSignedBatchWithdrawalFeeCommitment,
    zSignedSwapFeeCommitment,
    zBaseQuoteResponse,
    zTransferQuoteResponse,
    zWithdrawalQuoteResponse,
    zBatchWithdrawalQuoteResponse,
    zSwapQuoteResponse,
    zDustRescue,
} from "./evm.schemas";

export type EvmBaseFeeCommitment = z.infer<typeof zBaseFeeCommitment>;
export type EvmTransferFeeCommitment = z.infer<typeof zTransferFeeCommitment>;
export type EvmWithdrawalFeeCommitment = z.infer<typeof zWithdrawalFeeCommitment>;
export type EvmBatchWithdrawalFeeCommitment = z.infer<typeof zBatchWithdrawalFeeCommitment>;
export type EvmSwapFeeCommitment = z.infer<typeof zSwapFeeCommitment>;
export type EvmDustRescue = z.infer<typeof zDustRescue>;

export type EvmSignedTransferFeeCommitment = z.infer<typeof zSignedTransferFeeCommitment>;
export type EvmSignedWithdrawalFeeCommitment = z.infer<typeof zSignedWithdrawalFeeCommitment>;
export type EvmSignedBatchWithdrawalFeeCommitment = z.infer<typeof zSignedBatchWithdrawalFeeCommitment>;
export type EvmSignedSwapFeeCommitment = z.infer<typeof zSignedSwapFeeCommitment>;

export type EvmBaseQuoteResponse = z.infer<typeof zBaseQuoteResponse>;
export type EvmTransferQuoteResponse = z.infer<typeof zTransferQuoteResponse>;
export type EvmWithdrawalQuoteResponse = z.infer<typeof zWithdrawalQuoteResponse>;
export type EvmBatchWithdrawalQuoteResponse = z.infer<typeof zBatchWithdrawalQuoteResponse>;
export type EvmSwapQuoteResponse = z.infer<typeof zSwapQuoteResponse>;
