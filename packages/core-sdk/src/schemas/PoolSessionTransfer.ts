import { z } from "zod";

import { EMPTY_ADDRESS } from "../internal.js";
import { AddressSchema, HexSchema } from "./common.js";

/**
 * Builds every schema whose shape depends on the chain's address type `TAddress` for
 * PoolSessionTransfer, grouped together because `TransferParamsSchema` composes
 * `RecipientDiscoveryDataSchema`. `emptyAddress` is the chain's zero/sentinel address value,
 * used as the default for `relayAddress`/`processorAddress` when omitted.
 */
export function makePoolSessionTransferSchemas<TAddress extends string>(
    addressSchema: z.ZodType<TAddress>,
    emptyAddress: TAddress,
) {
    const recipientDiscoveryDataSchema = z.union([
        z.object({
            evmAddress: addressSchema,
            noteSecretsMap: z.map(HexSchema, HexSchema).optional(),
            publicViewingKey: z.never().optional(),
            hint: z.never().optional(),
            allowOutOfBandFallback: z.boolean().optional(),
        }),
        z.object({
            publicViewingKey: HexSchema,
            noteSecretsMap: z.map(HexSchema, HexSchema),
            hint: HexSchema.optional(),
            evmAddress: z.never().optional(),
        }),
        // Variant 3: payment-request fulfillment — pre-committed hashes, no secrets.
        z.object({
            publicViewingKey: HexSchema,
            noteAddressHashes: z.array(HexSchema).min(1),
            hint: HexSchema.optional(),
            noteSecretsMap: z.never().optional(),
            evmAddress: z.never().optional(),
        }),
    ]);

    const transferParamsSchema = z
        .object({
            inputCommitments: z.array(HexSchema).min(1),
            amount: HexSchema,
            tokenId: addressSchema,
            relayAddress: addressSchema.optional(),
            feeAmount: HexSchema.optional().default("0x0"),
            processorAddress: addressSchema.optional(),
        })
        .and(
            z
                .object({
                    recipientNoteAddressHash: z.array(HexSchema).min(1),
                    recipientNoteAddressHashByLabel: z.never().optional(),
                    recipientDiscoveryData: z.never().optional(),
                })
                .or(
                    z.object({
                        recipientNoteAddressHash: z.never().optional(),
                        recipientNoteAddressHashByLabel: z.map(HexSchema, HexSchema),
                        recipientDiscoveryData: z.never().optional(),
                    }),
                )
                .or(
                    z.object({
                        recipientNoteAddressHash: z.never().optional(),
                        recipientNoteAddressHashByLabel: z.never().optional(),
                        recipientDiscoveryData: recipientDiscoveryDataSchema,
                    }),
                ),
        );

    const coldStartTransferParamsSchema = z.object({
        inputCommitments: z.array(HexSchema).min(1),
        recipientEvmAddress: addressSchema,
        amount: HexSchema,
        tokenId: addressSchema,
        relayAddress: addressSchema.optional().default(emptyAddress),
        feeAmount: HexSchema.optional().default("0x0"),
        processorAddress: addressSchema.optional().default(emptyAddress),
    });

    return { recipientDiscoveryDataSchema, transferParamsSchema, coldStartTransferParamsSchema };
}

const evmPoolSessionTransferSchemas = makePoolSessionTransferSchemas(AddressSchema, EMPTY_ADDRESS);

/** Validates {@link RecipientDiscoveryData}. */
export const RecipientDiscoveryDataSchema =
    evmPoolSessionTransferSchemas.recipientDiscoveryDataSchema;
/** Validates per-call transfer parameters. */
export const TransferParamsSchema = evmPoolSessionTransferSchemas.transferParamsSchema;
/** Validates per-call cold start transfer parameters. */
export const ColdStartTransferParamsSchema =
    evmPoolSessionTransferSchemas.coldStartTransferParamsSchema;
