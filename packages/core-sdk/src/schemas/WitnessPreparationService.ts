import { z, ZodType } from "zod";

import { AddressSchema, DepositSecretSchema, HexSchema, NoteAddressHashSchema } from "./common.js";
import { makeNoteSchema, makePendingNoteSchema } from "./NoteManager.js";

export const OutputNoteParamsSchema = z.object({
    noteAddressHash: NoteAddressHashSchema,
    value: HexSchema,
    label: HexSchema,
});

export const BuildDepositWitnessInputsSchema = z.object({
    noteAddressHash: NoteAddressHashSchema,
    tokenId: HexSchema,
    value: HexSchema,
    context: HexSchema,
    depositSecret: DepositSecretSchema,
});

/**
 * Builds `BuildTransactWitnessInputsSchema` parameterized over the embedded notes' address type.
 * `inputNotes`/`changeNotes`/`recipientNotes` carry the caller's real chain-native `tokenId`/
 * `ownerAddress` (a Stellar StrKey, not `0x`-hex) — but `buildTransactWitness` never actually
 * reads those two per-note fields (only `commitment`/`value`/`label`/`noteSecret`/`createdAtBlock`
 * and, for outputs, `noteAddressHash` — verified by reading the method body), so validating them
 * against the caller's real address shape (rather than the EVM-defaulted default) is correct and
 * loses no safety: the fields are schema-checked for shape, never consumed numerically here.
 */
export function makeBuildTransactWitnessInputsSchema<TAddress>(addressSchema: ZodType<TAddress>) {
    return z
        .object({
            inputNotes: z.array(makeNoteSchema(addressSchema)).min(1, "At least one input note is required"),
            changeNotes: z
                .array(makePendingNoteSchema(addressSchema))
                .min(1, "At least one change note is required"),
            recipientNotes: z.array(makePendingNoteSchema(addressSchema)).optional(),
            ownerAddress: HexSchema,
            privateNullifyingKey: HexSchema,
            privateRevocableKey: HexSchema,
            tokenId: HexSchema,
            amountOut: HexSchema,
            tokenIdOut: HexSchema,
            context: HexSchema,
            stateLeaves: z.array(HexSchema).min(1, "At least one state leaf is required"),
            keystoreLeaves: z.array(HexSchema),
            aspLeaves: z.array(HexSchema).min(1, "At least one ASP leaf is required"),
            pendingKeystoreRegistration: z.boolean().optional(),
        })
        // Mirror the on-chain invariant from PoolVault.transact: when amountOut == 0
        // (internal transfer), the contract requires tokenIdOut == address(0) and
        // reverts with PoolVault_TokenIdMustBeZeroOnInternalTransfer otherwise.
        .refine(({ amountOut, tokenIdOut }) => BigInt(amountOut) !== 0n || BigInt(tokenIdOut) === 0n, {
            message: "tokenIdOut must be zero address when amountOut is zero (internal transfer)",
            path: ["tokenIdOut"],
        })
        // At least one keystore leaf is required, UNLESS this witness predicts a post-insertion
        // root (`pendingKeystoreRegistration`), where the owner's leaf is appended by the builder
        // and the on-chain tree may legitimately be empty (first-ever registration).
        .refine(
            ({ keystoreLeaves, pendingKeystoreRegistration }) =>
                keystoreLeaves.length >= 1 || pendingKeystoreRegistration === true,
            {
                message: "At least one keystore leaf is required",
                path: ["keystoreLeaves"],
            },
        );
}

export const BuildTransactWitnessInputsSchema = makeBuildTransactWitnessInputsSchema(AddressSchema);

/** See {@link makeBuildTransactWitnessInputsSchema}'s doc comment — same unused-field reasoning. */
export function makeBuildRagequitWitnessInputsSchema<TAddress>(addressSchema: ZodType<TAddress>) {
    return z.object({
        note: makeNoteSchema(addressSchema),
        ownerAddress: HexSchema,
        privateNullifyingKey: HexSchema,
        privateRevocableKey: HexSchema,
        tokenId: HexSchema,
        label: HexSchema,
        keystoreLeaves: z.array(HexSchema).min(1, "At least one keystore leaf is required"),
    });
}

export const BuildRagequitWitnessInputsSchema = makeBuildRagequitWitnessInputsSchema(AddressSchema);
