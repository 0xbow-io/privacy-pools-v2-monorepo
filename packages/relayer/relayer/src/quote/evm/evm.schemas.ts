import { z } from "zod";
import { MAX_BATCH } from "@privacy-pools-v2/core-sdk/batch-fee";
import { zNonNegativeBigInt } from "../../relayer.schemas";
import { zEvmAddress } from "../../config/evm/evm.config.schemas";
import { BPS, Gas, Wei } from "./unit.types";

// -========- Request schemas -========-

export const zEvmShieldedQuoteRequest = z.object({
    asset: zEvmAddress,
    commit: z.boolean(),
});

export const zEvmQuoteRequest = zEvmShieldedQuoteRequest.extend({
    recipient: zEvmAddress.optional(),
    extraGas: z.boolean().optional().default(false),
    amount: zNonNegativeBigInt.transform((v) => Wei(v)),
});

// Batch quote request: one recipient/asset for the whole batch, plus the
// per-item withdrawn values (`amounts`, in batch order). Mirrors the SDK's
// BatchWithdrawalQuoteParams.
export const zEvmBatchQuoteRequest = zEvmShieldedQuoteRequest.extend({
    recipient: zEvmAddress,
    extraGas: z.boolean().optional().default(false),
    // Cap at MAX_BATCH so the relayer never signs a batch quote for more items
    // than relayBatch can execute on-chain (audit M-1).
    amounts: z.array(zNonNegativeBigInt.transform((v) => Wei(v))).min(1).max(MAX_BATCH),
});

export type EvmShieldedQuoteRequest = z.infer<typeof zEvmShieldedQuoteRequest>;
export type EvmQuoteRequest = z.infer<typeof zEvmQuoteRequest>;
export type EvmBatchQuoteRequest = z.infer<typeof zEvmBatchQuoteRequest>;

const zHexString = z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .transform((v) => v as `0x${string}`);

export const zWeiAmount = zNonNegativeBigInt.transform((v) => Wei(v));
export const zOptionalWeiAmount = zNonNegativeBigInt.transform((v) => Wei(v)).optional();
export const zGasAmount = zNonNegativeBigInt.transform((v) => Gas(v));
export const zBpsAmount = zNonNegativeBigInt.transform((v) => BPS(v));

// -========- Fee commitment schemas -========-

export const zBaseFeeCommitment = z.object({
    data: zHexString,
    asset: zEvmAddress,
    expiration: z.number(),
    feeAmount: zWeiAmount,
});

export const zTransferFeeCommitment = zBaseFeeCommitment;

export const zWithdrawalFeeCommitment = zBaseFeeCommitment.extend({
    recipient: zEvmAddress,
    amountSent: zWeiAmount,
    amountReceived: zWeiAmount,
});

export const zSignedTransferFeeCommitment = zBaseFeeCommitment.extend({
    signedRelayerCommitment: zHexString,
});

export const zSignedWithdrawalFeeCommitment = zWithdrawalFeeCommitment.extend({
    signedRelayerCommitment: zHexString,
});

// Batch fee commitment wire shape. `data` ABI-encodes the whole PayoutRouting[].
// relayCost/feeBps/flatFee are the signed fee-model params the SDK recomputes
// each item's normal single-tx fee from (to verify the relayer's split).
export const zBatchWithdrawalFeeCommitment = z.object({
    data: zHexString,
    asset: zEvmAddress,
    expiration: z.number(),
    totalFee: zWeiAmount,
    maxRelayFee: zWeiAmount,
    relayCost: zWeiAmount,
    feeBps: zBpsAmount,
    flatFee: zWeiAmount,
});

export const zSignedBatchWithdrawalFeeCommitment = zBatchWithdrawalFeeCommitment.extend({
    signedRelayerCommitment: zHexString,
});

// -========- Swap fee commitment schemas -========-

export const zSwapFeeCommitment = zBaseFeeCommitment.extend({
    recipient: zEvmAddress,
    amountSent: zWeiAmount,
});

export const zSignedSwapFeeCommitment = zSwapFeeCommitment.extend({
    signedRelayerCommitment: zHexString,
});

// -========- Swap quote schemas -========-

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Structural mirror of the SDK's `RelaySwapDustRescue` wire shape
// (packages/sdk/src/types/RelayerInteractor.ts). RC-10: this is bound into the on-chain
// SwapRouting.dustRescue field (see swap_routing_abi.ts) — NOT into the relay request —
// so it inherits the same proof-context binding as every other routing field, instead of
// travelling on the unsigned relay request body with no anchor to the proof.
export const zStealthRecipientIdentifier = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("raw"), spendingPubKey: zHexString }),
    z.object({ kind: z.literal("canonical"), spendingPubKey: zHexString, viewingPubKey: zHexString }),
]);

export const zDustRescue = z.object({
    destinationChainId: z.number().int().positive(),
    // Chain type `destinationChainId` is scoped to (e.g. "evm", "stellar") — a bare
    // numeric chain ID is ambiguous once more than one chain type exists. Not threaded
    // into the on-chain SwapRouting.dustRescue struct (see swap_routing_abi.ts): the
    // relayer resolves it off-chain, before ever building that struct.
    destinationChainType: z
        .string()
        .min(1)
        .regex(/^[a-z0-9-]+$/, "destinationChainType must be a lowercase alphanumeric slug"),
    tokenId: zEvmAddress,
    recipientIdentifier: zStealthRecipientIdentifier,
});

export const zEvmSwapQuoteRequest = z
    .object({
        asset: zEvmAddress,
        amount: zNonNegativeBigInt.transform((v) => Wei(v)),
        outputToken: zEvmAddress,
        recipient: zEvmAddress,
        fallbackAddress: zEvmAddress.optional(),
        minOutputAmount: zNonNegativeBigInt.transform((v) => Wei(v)),
        // Boolean flag, mirroring the withdrawal path: the RELAYER computes the
        // ETH top-up amount (extraGasFundAmount × gasPrice, capped) and folds its
        // cost into feeAmount. Clients never choose the amount.
        extraGas: z.boolean().optional().default(false),
        swapCalldata: zHexString.optional() as z.ZodType<`0x${string}` | undefined>,
        swapTarget: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() as z.ZodType<`0x${string}` | undefined>,
        approvalAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() as z.ZodType<`0x${string}` | undefined>,
        // B2 — self-funded bridge msg.value (Mainnet-destination reshield). Only meaningful
        // together, on a committed reshield quote (recipient == address(0)); omitted /
        // zero on every other path. See RelaySwaps.sol SwapRouting NatSpec.
        swapValue: zNonNegativeBigInt.transform((v) => Wei(v)).optional(),
        gasSwapMaxInput: zNonNegativeBigInt.transform((v) => Wei(v)).optional(),
        gasSwapCalldata: zHexString.optional() as z.ZodType<`0x${string}` | undefined>,
        dustRecipient: zEvmAddress,
        // RC-10: opt-in dust rescue, encoded into the committed routing's dustRescue field
        // (see quote/evm/evm.quote.service.ts). Only meaningful on a committed reshield/
        // cross-chain quote (recipient == address(0)) — see the refinement below.
        dustRescue: zDustRescue.optional(),
        commit: z.boolean(),
    })
    .superRefine((req, ctx) => {
        // Committed quotes build (and sign) the RelaySwaps routing struct, which needs
        // the full swap calldata and target. Require them here so a malformed committed
        // request fails validation cleanly instead of crashing during fee-commitment encoding.
        if (req.commit) {
            if (!req.swapCalldata) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "swapCalldata is required for committed swap quotes",
                    path: ["swapCalldata"],
                });
            }
            if (!req.swapTarget) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "swapTarget is required for committed swap quotes",
                    path: ["swapTarget"],
                });
            }
            // B2: a Mainnet-destination reshield carries swapValue > 0; the in-contract
            // gas swap then also needs its own calldata and a bounded-approval ceiling.
            if (req.swapValue !== undefined && req.swapValue > 0n) {
                if (!req.gasSwapCalldata) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "gasSwapCalldata is required when swapValue > 0",
                        path: ["gasSwapCalldata"],
                    });
                }
                if (req.gasSwapMaxInput === undefined || req.gasSwapMaxInput === 0n) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "gasSwapMaxInput must be > 0 when swapValue > 0",
                        path: ["gasSwapMaxInput"],
                    });
                }
            }
        }

        // recipient == address(0) means no source-chain recipient (reshield or cross-chain
        // swap). RelaySwaps.sol rejects nonzero nativeGas / minOutputAmount in that mode —
        // fail here at quote time instead of at simulation.
        if (req.recipient === ZERO_ADDRESS) {
            if (req.extraGas) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["extraGas"],
                    message: "extraGas is not supported when recipient is the zero address",
                });
            }
            if (req.minOutputAmount > 0n) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["minOutputAmount"],
                    message: "minOutputAmount must be 0 when recipient is the zero address",
                });
            }
        }

        // RC-10: dustRescue only makes sense when there is no source-chain recipient
        // (reshield or cross-chain swap) — an ordinary same-chain swap-to-self has
        // nothing for the relayer to rescue on a destination chain. Rejecting the
        // combination here means a commitment is never even signed for it.
        if (req.dustRescue && req.recipient !== ZERO_ADDRESS) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["dustRescue"],
                message: "dustRescue may only be requested when recipient is the zero address (reshield or cross-chain swap)",
            });
        }
    });

// -========- Response schemas -========-

export const zBaseQuoteResponse = z.object({
    txCost: zGasAmount,
    gasPrice: zWeiAmount,
    feeAmount: zWeiAmount,
});

export const zTransferQuoteResponse = zBaseQuoteResponse.extend({
    processor: zEvmAddress,
    feeCommitment: zSignedTransferFeeCommitment.optional(),
});

export const zSwapQuoteResponse = zBaseQuoteResponse.extend({
    feeCommitment: zSignedSwapFeeCommitment.optional(),
});

export const zWithdrawalQuoteResponse = zBaseQuoteResponse.extend({
    processor: zEvmAddress,
    amountSent: zWeiAmount,
    amountReceived: zWeiAmount,
    extraGasTxCost: zGasAmount.optional(),
    extraGasFundAmount: zGasAmount.optional(),
    feeCommitment: zSignedWithdrawalFeeCommitment.optional(),
});

// Batch quote response mirrors the SDK's BatchWithdrawalRelayerQuote: one
// aggregate fee and one signed batch commitment for the whole batch.
export const zBatchWithdrawalQuoteResponse = z.object({
    txCost: zGasAmount,
    gasPrice: zWeiAmount,
    totalFee: zWeiAmount,
    maxRelayFee: zWeiAmount,
    // Optional: only present when the request set `commit: true`. A non-committing
    // quote returns the fee estimate WITHOUT an EIP-712 signature, matching the
    // single-withdraw quote path (which gates signing on `commit === true`). This
    // prevents an unauthenticated caller from forcing unbounded signer work via
    // POST /v1/quote/.../batch (code-review R1 SEC-1).
    feeCommitment: zSignedBatchWithdrawalFeeCommitment.optional(),
});
