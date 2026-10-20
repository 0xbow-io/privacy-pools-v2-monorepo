import { z } from "zod";

import type { Hex } from "../types/Hex.js";
import { AddressSchema, HexSchema, NoteAddressHashSchema } from "./common.js";

/**
 * Builds every schema whose shape depends on the chain's address type `TAddress` for
 * PoolSessionDeposit: the constructor config, per-call deposit params, and the depositFor
 * discovery-data union — grouped together because `DepositForParamsSchema` composes the others.
 */
export function makePoolSessionDepositSchemas<TAddress>(addressSchema: z.ZodType<TAddress>) {
    const poolSessionDepositConfigSchema = z.object({
        ownerAddress: addressSchema,
    });

    const depositParamsSchema = z.object({
        tokenId: addressSchema,
        value: HexSchema,
    });

    const depositForDiscoveryDataSchema = z.union([
        z.object({
            evmAddress: addressSchema,
            noteSecret: HexSchema.optional(),
            allowOutOfBandFallback: z.boolean().optional(),
            publicViewingKey: z.never().optional(),
            noteAddressHash: z.never().optional(),
        }),
        z.object({
            publicViewingKey: HexSchema,
            noteAddressHash: NoteAddressHashSchema,
            noteSecret: HexSchema,
            evmAddress: z.never().optional(),
        }),
    ]);

    // A blind deposit's noteData: the payload itself, or a builder the SDK calls once the note is
    // fixed (NoteDataBuilder). The builder's output is re-validated where it is called. The SDK
    // calls the builder synchronously, so an async one is refused here, at parse time, rather
    // than failing later as an invalid (pending Promise) payload. Object.prototype.toString tags
    // native async functions "[object AsyncFunction]" and survives minification.
    const noteDataPayloadSchema = z.object({ hint: HexSchema, data: HexSchema });
    const noteDataSchema = z.union([
        noteDataPayloadSchema,
        z.custom<(...args: never[]) => { hint: Hex; data: Hex }>(
            (value) =>
                typeof value === "function" &&
                Object.prototype.toString.call(value) !== "[object AsyncFunction]",
            {
                message:
                    "noteData must be { hint, data } or a synchronous builder function. Async builders are not supported",
            },
        ),
    ]);

    // The recipient half of depositFor (DepositForRecipient): reused by swap-and-deposit and
    // yield deposit params, so every surface accepts exactly the same recipient forms.
    const depositForRecipientSchema = z
        .object({
            discoveryData: z.never().optional(),
            noteAddressHash: NoteAddressHashSchema,
            noteData: noteDataSchema.optional(),
            depositSecret: HexSchema.optional(),
        })
        .or(
            z.object({
                noteAddressHash: z.never().optional(),
                discoveryData: depositForDiscoveryDataSchema,
                noteData: z.never().optional(),
                depositSecret: z.never().optional(),
            }),
        );

    const depositForParamsSchema = depositParamsSchema.and(depositForRecipientSchema);

    return {
        poolSessionDepositConfigSchema,
        depositParamsSchema,
        depositForDiscoveryDataSchema,
        depositForRecipientSchema,
        depositForParamsSchema,
        noteDataPayloadSchema,
    };
}

const evmPoolSessionDepositSchemas = makePoolSessionDepositSchemas(AddressSchema);

/** Validates the constructor config for PoolSessionDeposit. */
export const PoolSessionDepositConfigSchema =
    evmPoolSessionDepositSchemas.poolSessionDepositConfigSchema;
/** Validates per-call deposit parameters. */
export const DepositParamsSchema = evmPoolSessionDepositSchemas.depositParamsSchema;
/** Validates the recipient half of depositFor (also `SwapAndDepositParams.recipient`). */
export const DepositForRecipientSchema = evmPoolSessionDepositSchemas.depositForRecipientSchema;
/** Validates per-call depositFor parameters. Mutually exclusive: `noteAddressHash` XOR `discoveryData`. */
export const DepositForParamsSchema = evmPoolSessionDepositSchemas.depositForParamsSchema;
