import { z } from "zod";
import { HexSchema } from "../internal.js";

/**
 * Runtime validation matching the relayer's real wire shapes — verified directly against
 * `packages/relayer/relayer/src/quote/stellar/schemas.ts` and `relay/stellar/schemas.ts`, not
 * assumed. See {@link StellarWithdrawalFeeCommitmentWire}'s doc comment for what `data`/
 * `signedRelayerCommitment` actually encode (both opaque to this client either way) — both are
 * `0x`-prefixed hex on the wire, matching core-sdk's `FeeCommitment.data`/`Hex` contract.
 */
export const StellarWithdrawalFeeCommitmentWireSchema = z.object({
    data: HexSchema,
    asset: z.string(),
    expiration: z.number(),
    feeAmount: z.string(),
    recipient: z.string(),
    amountSent: z.string(),
    amountReceived: z.string(),
    signedRelayerCommitment: HexSchema,
});

/** `POST /v1/quote/stellar/{chainId}/{send|receive}` response. */
export const StellarWithdrawalQuoteResponseWireSchema = z.object({
    feeAmount: z.string(),
    amountSent: z.string(),
    amountReceived: z.string(),
    feeCommitment: StellarWithdrawalFeeCommitmentWireSchema.optional(),
});

/** `POST /v1/relay/stellar/{chainId}/withdrawal` response. */
export const StellarRelayResponseWireSchema = z.object({
    txHash: HexSchema,
    error: z.string().optional(),
});

/** A signed batch fee commitment as the relayer sends it (bigints as decimal strings). */
export const StellarBatchFeeCommitmentWireSchema = z.object({
    data: HexSchema,
    asset: z.string(),
    expiration: z.number(),
    totalFee: z.string(),
    maxRelayFee: z.string(),
    relayCost: z.string(),
    feeBps: z.string(),
    flatFee: z.string(),
    signedRelayerCommitment: HexSchema,
});

/** `POST /v1/quote/stellar/{chainId}/batch` response. */
export const StellarBatchQuoteResponseWireSchema = z.object({
    txCost: z.string(),
    gasPrice: z.string(),
    totalFee: z.string(),
    maxRelayFee: z.string(),
    feeCommitment: StellarBatchFeeCommitmentWireSchema.optional(),
});

/** A signed private-transfer fee commitment (bigints as decimal strings). */
export const StellarTransferFeeCommitmentWireSchema = z.object({
    data: HexSchema,
    asset: z.string(),
    expiration: z.number(),
    feeAmount: z.string(),
    signedRelayerCommitment: HexSchema,
});

/** `POST /v1/quote/stellar/{chainId}/transfer` response. */
export const StellarTransferQuoteResponseWireSchema = z.object({
    feeAmount: z.string(),
    txCost: z.string(),
    gasPrice: z.string(),
    feeCommitment: StellarTransferFeeCommitmentWireSchema.optional(),
});
