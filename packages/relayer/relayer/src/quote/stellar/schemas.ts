import { z } from "zod";
import { zNonNegativeBigInt, zHex } from "../../relayer.schemas";
import { zStellarAddress } from "../../config/stellar/stellar.config.schemas";

// -========- Fee commitment schemas -========-

export const zStellarWithdrawalFeeCommitment = z.object({
    data: zHex,
    asset: zStellarAddress,
    expiration: z.number(),
    feeAmount: zNonNegativeBigInt,
    recipient: zStellarAddress,
    amountSent: zNonNegativeBigInt,
    amountReceived: zNonNegativeBigInt,
});

export const zStellarSignedWithdrawalFeeCommitment = zStellarWithdrawalFeeCommitment.extend({
    signedRelayerCommitment: zHex,
});

// -========- Request/response schemas -========-

export const zStellarQuoteRequest = z.object({
    asset: zStellarAddress,
    amount: zNonNegativeBigInt,
    recipient: zStellarAddress.optional(),
    commit: z.boolean(),
});

export const zStellarQuoteResponse = z.object({
    feeAmount: zNonNegativeBigInt,
    amountSent: zNonNegativeBigInt,
    amountReceived: zNonNegativeBigInt,
    feeCommitment: zStellarSignedWithdrawalFeeCommitment.optional(),
});

// -========- Transfer schemas -========-

export const zStellarTransferQuoteRequest = z.object({
    asset: zStellarAddress,
    commit: z.boolean(),
});

/**
 * A private-transfer fee commitment. `data` is the PayoutRouting encoding of (feeReceiver,
 * feeReceiver, feeAmount) — the transact's `processor_data`, so the proof binds the relayer's fee
 * terms; the only value that leaves the pool is `feeAmount`, paid to the submitting relayer.
 */
export const zStellarTransferFeeCommitment = z.object({
    data: zHex,
    asset: zStellarAddress,
    expiration: z.number(),
    feeAmount: zNonNegativeBigInt,
});

export const zStellarSignedTransferFeeCommitment = zStellarTransferFeeCommitment.extend({
    signedRelayerCommitment: zHex,
});

export const zStellarTransferQuoteResponse = z.object({
    feeAmount: zNonNegativeBigInt,
    txCost: zNonNegativeBigInt,
    gasPrice: zNonNegativeBigInt,
    feeCommitment: zStellarSignedTransferFeeCommitment.optional(),
});

// -========- Batch schemas -========-

// The relay contract's MAX_BATCH (contracts/relay/src/lib.rs), equal to core-sdk's; bounding the
// array here keeps an unauthenticated request from forcing O(N) work before anything is checked.
export const STELLAR_MAX_BATCH = 10;

export const zStellarBatchQuoteRequest = z.object({
    asset: zStellarAddress,
    recipient: zStellarAddress,
    amounts: z.array(zNonNegativeBigInt).min(1).max(STELLAR_MAX_BATCH),
    commit: z.boolean(),
    extraGas: z.boolean().optional(),
});

/**
 * An aggregate batch fee commitment: `data` is the item routings concatenated (the SDK's
 * `StellarPayoutRoutingCodec.encodeArray` layout), signed together with the fee model so the SDK
 * can recompute every item's fee.
 */
export const zStellarBatchFeeCommitment = z.object({
    data: zHex,
    asset: zStellarAddress,
    expiration: z.number(),
    totalFee: zNonNegativeBigInt,
    maxRelayFee: zNonNegativeBigInt,
    relayCost: zNonNegativeBigInt,
    feeBps: zNonNegativeBigInt,
    flatFee: zNonNegativeBigInt,
});

export const zStellarSignedBatchFeeCommitment = zStellarBatchFeeCommitment.extend({
    signedRelayerCommitment: zHex,
});

export const zStellarBatchQuoteResponse = z.object({
    txCost: zNonNegativeBigInt,
    gasPrice: zNonNegativeBigInt,
    totalFee: zNonNegativeBigInt,
    maxRelayFee: zNonNegativeBigInt,
    feeCommitment: zStellarSignedBatchFeeCommitment.optional(),
});

// Trivial placeholder for the not-implemented quote operations (transfer/batch/swap) — no
// Stellar wire shape exists for them (see relay/stellar/schemas.ts's identical placeholder).
export const zStellarQuoteNotImplemented = z.object({}).passthrough();
