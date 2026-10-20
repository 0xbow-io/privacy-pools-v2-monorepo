import { z } from "zod";

import type { Hex } from "../internal.js";
// Direct import (not via internal.js): `internal.js` re-exports `constant/` AFTER
// `schemas/`, so pulling MAX_BATCH through the barrel would read it before it is
// initialized (these `.max(...)` calls run at module-load time). The constant
// file has zero imports, so a direct import is safe and load-order-independent.
import { MAX_BATCH } from "../constant/BatchWithdraw.js";
import { AddressSchema, HexSchema as HexIntegerSchema } from "./common.js";
import { NoteDataSchema } from "./ContractInteractor.js";
import { ProofResultSchema } from "./ProofService.js";

export const RelayerUrlSchema = z.url("Must be a valid URL").refine(
    (value) => {
        const protocol = value.split("://")[0];
        return ["http", "https"].includes(protocol!);
    },
    { message: "Must use http or https protocol" },
);

const HexSchema = z
    .string()
    .regex(/^0x[0-9a-fA-F]*$/, "Must be a valid hex string")
    .transform((value) => value as Hex);

// EVM-bound (hardcoded HexSchema), kept only because `SwapFeeCommitmentSchema` below — permanently
// EVM-only, the swap subsystem is out of scope for genericization — extends it. Every other
// consumer uses `makeRelayerAddressSchemas`'s address-parameterized `feeCommitmentSchema`/
// `withdrawalFeeCommitmentSchema` instead.
const SwapBaseFeeCommitmentSchema = z.object({
    data: HexSchema,
    asset: HexSchema,
    expiration: z.number(),
    feeAmount: z.string(),
    signedRelayerCommitment: HexSchema,
});

export const BatchFeeCommitmentSchema = z.object({
    data: HexSchema,
    asset: HexSchema,
    expiration: z.number(),
    totalFee: z.string(),
    maxRelayFee: z.string(),
    relayCost: z.string(),
    feeBps: z.string(),
    flatFee: z.string(),
    signedRelayerCommitment: HexSchema,
});

export const BatchWithdrawalRelayerQuoteSchema = z.object({
    txCost: z.string(),
    gasPrice: z.string(),
    totalFee: z.string(),
    maxRelayFee: z.string(),
    feeCommitment: BatchFeeCommitmentSchema,
});

export const BatchWithdrawalRelayItemSchema = z.object({
    proof: ProofResultSchema,
    noteData: z.array(NoteDataSchema),
    inputNullifierNumber: z.number(),
    outputCommitmentNumber: z.number(),
});

export const BatchWithdrawalRelayParamsSchema = z.object({
    items: z
        .array(BatchWithdrawalRelayItemSchema)
        .min(1, "Batch must contain at least one item")
        .max(MAX_BATCH),
    signedBatchFeeCommitment: BatchFeeCommitmentSchema,
});

export const SwapFeeCommitmentSchema = SwapBaseFeeCommitmentSchema.extend({
    recipient: HexSchema,
    amountSent: z.string(),
});

// A relayer quote before any commitment is attached (`commit: false`): a fee
// estimate of txCost/gasPrice/feeAmount only. Neutral base — the committed swap
// quote extends it, and callers that only size the swap parse against this.
export const UncommittedQuoteSchema = z.object({
    txCost: z.string(),
    gasPrice: z.string(),
    feeAmount: z.string(),
});

// A committed swap quote (`commit: true`) adds the relayer's signed fee
// commitment. Parsed only when the request carried swapCalldata/swapTarget.
export const SwapRelayerQuoteSchema = UncommittedQuoteSchema.extend({
    feeCommitment: SwapFeeCommitmentSchema,
});

const StealthRecipientIdentifierSchema = z.union([
    z.object({ kind: z.literal("raw"), spendingPubKey: HexSchema }),
    z.object({ kind: z.literal("canonical"), spendingPubKey: HexSchema, viewingPubKey: HexSchema }),
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Builds every schema whose shape depends on the chain's address type `TAddress` —
 * `RelayerInfoSchema`/`RelayerInteractorConfigSchema`, the quote-request schemas
 * (transfer/withdrawal/batch-withdrawal/swap), and the withdrawal/registration/
 * announcement/swap relay-param schemas that carry an address field (`processorAddress`,
 * `account`, `stealthAddress`, `tokenId`) — grouped together because several extend or nest one
 * another and must compose against the same `addressSchema`.
 */
export function makeRelayerAddressSchemas<TAddress>(addressSchema: z.ZodType<TAddress>) {
    const feeCommitmentSchema = z.object({
        data: HexSchema,
        asset: addressSchema,
        expiration: z.number(),
        feeAmount: z.string(),
        signedRelayerCommitment: HexSchema,
    });

    const withdrawalFeeCommitmentSchema = feeCommitmentSchema.extend({
        recipient: addressSchema,
        amountSent: z.string(),
        amountReceived: z.string(),
        extraGas: z.boolean().default(false),
    });

    const transferRelayerQuoteSchema = z.object({
        txCost: z.string(),
        gasPrice: z.string(),
        feeAmount: z.string(),
        feeCommitment: feeCommitmentSchema,
    });

    const withdrawalRelayerQuoteSchema = z.object({
        txCost: z.string(),
        gasPrice: z.string(),
        feeAmount: z.string(),
        amountSent: z.string(),
        amountReceived: z.string(),
        feeCommitment: withdrawalFeeCommitmentSchema,
    });

    const transferRelayParamsSchema = z.object({
        proof: ProofResultSchema,
        noteData: z.array(NoteDataSchema),
        signedFeeCommitment: feeCommitmentSchema,
        inputNullifierNumber: z.number(),
        outputCommitmentNumber: z.number(),
    });

    const transferQuoteParamsSchema = z.object({
        asset: addressSchema,
        commit: z.boolean(),
    });

    const withdrawalQuoteParamsSchema = transferQuoteParamsSchema.extend({
        recipient: addressSchema,
        extraGas: z.boolean(),
        amount: z.string(),
    });

    const batchWithdrawalQuoteParamsSchema = z.object({
        asset: addressSchema,
        commit: z.boolean(),
        recipient: addressSchema,
        extraGas: z.boolean(),
        amounts: z.array(z.string()).max(MAX_BATCH),
    });

    const relaySwapDustRescueSchema = z.object({
        destinationChainId: z.number().int().positive(),
        // Chain type `destinationChainId` is scoped to — a bare numeric chain ID is
        // ambiguous once more than one chain type exists. Same slug constraint as
        // `relayerInfoSchema.chainType` below.
        destinationChainType: z
            .string()
            .min(1)
            .regex(/^[a-z0-9-]+$/, "destinationChainType must be a lowercase alphanumeric slug"),
        tokenId: addressSchema,
        recipientIdentifier: StealthRecipientIdentifierSchema,
    });

    const swapQuoteParamsSchema = transferQuoteParamsSchema
        .extend({
            recipient: addressSchema,
            fallbackAddress: addressSchema.optional(),
            amount: z.string(),
            outputToken: addressSchema,
            minOutputAmount: z.string(),
            extraGas: z.boolean().default(false),
            swapCalldata: HexSchema.optional(),
            swapTarget: addressSchema.optional(),
            approvalAddress: addressSchema.optional(),
            // B2 — self-funded bridge msg.value (Mainnet-destination reshield). Only meaningful
            // together, on a committed reshield quote; omitted / zero on every other path.
            swapValue: z.string().optional(),
            gasSwapMaxInput: z.string().optional(),
            gasSwapCalldata: HexSchema.optional(),
            dustRecipient: addressSchema,
            // RC-10: opt-in dust rescue, encoded into the relayer's signed routing at quote
            // time. Only valid when recipient is the zero address — see the refinement below.
            dustRescue: relaySwapDustRescueSchema.optional(),
        })
        .superRefine((params, ctx) => {
            // Committed quotes make the relayer encode (and sign) the RelaySwaps routing
            // struct, which needs the full swap calldata and target. Require them here so a
            // malformed committed request fails client-side instead of at the relayer.
            if (!params.commit) return;
            if (!params.swapCalldata) {
                ctx.addIssue({
                    code: "custom",
                    path: ["swapCalldata"],
                    message: "swapCalldata is required for committed swap quotes",
                });
            }
            if (!params.swapTarget) {
                ctx.addIssue({
                    code: "custom",
                    path: ["swapTarget"],
                    message: "swapTarget is required for committed swap quotes",
                });
            }
            // B2: swapValue > 0 (Mainnet destination) needs the gas-swap calldata and its
            // bounded-approval ceiling alongside it.
            if (params.swapValue !== undefined && BigInt(params.swapValue) > 0n) {
                if (!params.gasSwapCalldata) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["gasSwapCalldata"],
                        message: "gasSwapCalldata is required when swapValue > 0",
                    });
                }
                if (params.gasSwapMaxInput === undefined || BigInt(params.gasSwapMaxInput) === 0n) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["gasSwapMaxInput"],
                        message: "gasSwapMaxInput must be > 0 when swapValue > 0",
                    });
                }
            }
            // RC-10: dustRescue only makes sense when there is no source-chain recipient
            // (reshield or cross-chain swap) — mirrors the relayer's own quote-time refinement.
            if (params.dustRescue && String(params.recipient).toLowerCase() !== ZERO_ADDRESS) {
                ctx.addIssue({
                    code: "custom",
                    path: ["dustRescue"],
                    message:
                        "dustRescue may only be requested when recipient is the zero address (reshield or cross-chain swap)",
                });
            }
        });

    const relayerInfoSchema = z.object({
        url: RelayerUrlSchema,
        name: z.string(),
        chainId: z.number(),
        /**
         * Slug interpolated into relayer request paths
         * (`/v1/quote/{chainType}/{chainId}/...`). Constrained to lowercase
         * alphanumerics + dashes so a malicious config cannot inject path
         * traversal or extra path segments.
         */
        chainType: z
            .string()
            .min(1)
            .regex(/^[a-z0-9-]+$/, "chainType must be a lowercase alphanumeric slug"),
        status: z.enum(["active", "inactive"]),
        address: addressSchema,
        processorAddress: addressSchema,
    });

    const relayerInteractorConfigSchema = z.object({
        relayers: z.array(relayerInfoSchema).min(1, "At least one relayer is required"),
    });

    const withdrawalRelayParamsSchema = transferRelayParamsSchema.extend({
        signedFeeCommitment: withdrawalFeeCommitmentSchema,
        // Optional yield-withdrawal routing. Zod strips unknown keys by default, so these MUST be
        // declared here or a relayed yield withdrawal (PPRouter.withdrawToUnderlying) is
        // unreachable: the fields would be silently dropped before the POST body is built.
        processorAddress: addressSchema.optional(),
        minUnderlyingOut: HexIntegerSchema.optional(),
    });

    const relayedRegistrationFieldsSchema = z.object({
        account: addressSchema,
        authDigest: HexIntegerSchema,
        nullifyingKeyHash: HexIntegerSchema,
        deadline: HexIntegerSchema,
        signature: HexIntegerSchema,
    });

    const registerAndWithdrawalRelayParamsSchema = withdrawalRelayParamsSchema.extend({
        // Nested (not spread) so the relayer reads one `registration` object. Declared
        // explicitly — Zod strips unknown keys, so an omitted field here would silently drop the
        // whole registration leg from the POST body and the relayer would fall back to a plain
        // relay.
        registration: relayedRegistrationFieldsSchema,
    });

    const stealthAnnouncementFieldsSchema = z.object({
        schemeId: HexIntegerSchema,
        stealthAddress: addressSchema,
        ephemeralPubKey: HexIntegerSchema,
        metadata: HexIntegerSchema,
    });

    const relayAndAnnounceRelayParamsSchema = withdrawalRelayParamsSchema.extend({
        // Declared explicitly (not spread) so the whole `announcement` leg survives Zod — an
        // omitted key would silently drop it from the POST body and the relayer would fall back
        // to a plain relay.
        announcement: stealthAnnouncementFieldsSchema,
    });

    const swapRelayParamsSchema = z.object({
        proof: ProofResultSchema,
        noteData: z.array(NoteDataSchema),
        signedSwapCommitment: SwapFeeCommitmentSchema,
        inputNullifierNumber: z.number(),
        outputCommitmentNumber: z.number(),
    });

    return {
        feeCommitmentSchema,
        withdrawalFeeCommitmentSchema,
        transferRelayerQuoteSchema,
        withdrawalRelayerQuoteSchema,
        transferRelayParamsSchema,
        transferQuoteParamsSchema,
        withdrawalQuoteParamsSchema,
        batchWithdrawalQuoteParamsSchema,
        swapQuoteParamsSchema,
        relayerInfoSchema,
        relayerInteractorConfigSchema,
        withdrawalRelayParamsSchema,
        relayedRegistrationFieldsSchema,
        registerAndWithdrawalRelayParamsSchema,
        stealthAnnouncementFieldsSchema,
        relayAndAnnounceRelayParamsSchema,
        relaySwapDustRescueSchema,
        swapRelayParamsSchema,
    };
}

const evmRelayerAddressSchemas = makeRelayerAddressSchemas(AddressSchema);

export const FeeCommitmentSchema = evmRelayerAddressSchemas.feeCommitmentSchema;
export const WithdrawalFeeCommitmentSchema = evmRelayerAddressSchemas.withdrawalFeeCommitmentSchema;
export const RelayerQuoteSchema = evmRelayerAddressSchemas.transferRelayerQuoteSchema;
export const WithdrawalRelayerQuoteSchema = evmRelayerAddressSchemas.withdrawalRelayerQuoteSchema;
export const TransferRelayParamsSchema = evmRelayerAddressSchemas.transferRelayParamsSchema;
export const TransferQuoteParamsSchema = evmRelayerAddressSchemas.transferQuoteParamsSchema;
export const WithdrawalQuoteParamsSchema = evmRelayerAddressSchemas.withdrawalQuoteParamsSchema;
export const BatchWithdrawalQuoteParamsSchema =
    evmRelayerAddressSchemas.batchWithdrawalQuoteParamsSchema;
export const SwapQuoteParamsSchema = evmRelayerAddressSchemas.swapQuoteParamsSchema;
export const RelayerInfoSchema = evmRelayerAddressSchemas.relayerInfoSchema;
export const RelayerInteractorConfigSchema = evmRelayerAddressSchemas.relayerInteractorConfigSchema;
export const WithdrawalRelayParamsSchema = evmRelayerAddressSchemas.withdrawalRelayParamsSchema;
export const RelayedRegistrationFieldsSchema =
    evmRelayerAddressSchemas.relayedRegistrationFieldsSchema;
export const RegisterKeystoreRelayParamsSchema = RelayedRegistrationFieldsSchema;
export const RegisterAndWithdrawalRelayParamsSchema =
    evmRelayerAddressSchemas.registerAndWithdrawalRelayParamsSchema;
export const StealthAnnouncementFieldsSchema =
    evmRelayerAddressSchemas.stealthAnnouncementFieldsSchema;
export const RelayAndAnnounceRelayParamsSchema =
    evmRelayerAddressSchemas.relayAndAnnounceRelayParamsSchema;
export const SwapRelayParamsSchema = evmRelayerAddressSchemas.swapRelayParamsSchema;

/**
 * Builds the `/v1/details` response schemas for a given chain's address type `TAddress` —
 * grouped in their own factory (rather than folded into `makeRelayerAddressSchemas`) since chain
 * details is a discovery concern orthogonal to the quote/relay request schemas that factory
 * builds, with its own EVM-shaped-but-optional fields (see `RelayerChainDetails`'s doc comment
 * in `types/RelayerInteractor.ts` for why a non-EVM chain maps its own topology down into this
 * shape rather than the shape growing a field per chain).
 */
/**
 * A published native-wei cap, normalized to a decimal string. The relayer serializes it as a
 * decimal string (bigint `toJSON`); a `0x` hex string or a non-negative safe-integer number is
 * accepted too. Anything else — a precision-lost number, garbage — becomes undefined (cap
 * unknown, the relayer still enforces it) rather than an error.
 */
const relayerCapSchema = z
    .unknown()
    .transform((v): string | undefined => {
        if (typeof v === "string" && /^(\d+|0x[0-9a-fA-F]+)$/.test(v)) return BigInt(v).toString();
        if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
        return undefined;
    })
    .optional();

export function makeRelayerChainDetailsSchemas<TAddress>(addressSchema: z.ZodType<TAddress>) {
    const relayerYieldWrapperSchema = z.object({
        ppToken: addressSchema,
        underlying: addressSchema,
        router: addressSchema,
        zap: addressSchema,
        ppDecimals: z.number().int().nonnegative(),
        underlyingDecimals: z.number().int().nonnegative(),
        underlyingSymbol: z.string(),
    });

    /**
     * `GET {url}/v1/details/{chainType}/{chainId}` — the relayer's own statement of which
     * addresses it relays through. `relayerAddress` / `processors` / `yield` are optional so
     * relayers predating discovery still parse; every other field has been published since 1.0.
     */
    const relayerChainDetailsSchema = z.object({
        id: z.number(),
        name: z.string(),
        type: z.string(),
        contracts: z.object({
            entrypoint: addressSchema,
            poolVault: addressSchema,
            relay: addressSchema,
            relaySwaps: addressSchema.optional(),
        }),
        swapsSupported: z.boolean(),
        // Optional so relayers predating its publication parse; absent is treated as allowed.
        destinationCallsSupported: z.boolean().optional(),
        assets: z.array(
            z.object({
                address: addressSchema,
                ticker: z.string(),
                fixedFeeAmount: z.union([z.string(), z.number()]).optional(),
                feeBPS: z.union([z.string(), z.number()]).optional(),
            }),
        ),
        relayerAddress: addressSchema.optional(),
        processors: z.array(addressSchema).optional(),
        yield: z.array(relayerYieldWrapperSchema).optional(),
        // Enforced B2 native-wei ceiling; optional so relayers predating its publication parse,
        // and lenient (see relayerCapSchema) so a cap in an unexpected encoding cannot fail the
        // whole response — it also carries discovery (relayerAddress, processors, yield).
        maxSwapValueWei: relayerCapSchema,
    });

    return { relayerYieldWrapperSchema, relayerChainDetailsSchema };
}

const evmRelayerChainDetailsSchemas = makeRelayerChainDetailsSchemas(AddressSchema);

/** One yield wrapper published by the relayer (`/v1/details` → `yield[]`). */
export const RelayerYieldWrapperSchema = evmRelayerChainDetailsSchemas.relayerYieldWrapperSchema;
export const RelayerChainDetailsSchema = evmRelayerChainDetailsSchemas.relayerChainDetailsSchema;
