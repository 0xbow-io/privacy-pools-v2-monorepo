import { z } from "zod";

import { KEYSTORE_MAX_DEPTH, STATE_MAX_DEPTH } from "../constant/index.js";
import { AddressSchema, BigIntSchema, BooleanSchema, HexSchema } from "./common.js";

// A leaf index is 0-based, so a valid index is strictly below the tree's capacity. Bounding to
// the real depth (not Number.MAX_SAFE_INTEGER) stops a hostile RPC from returning a ~9e15 index
// that allocates a giant sparse array in the Merkle builder before any other check runs.
const MAX_KEYSTORE_LEAF_INDEX = 2 ** KEYSTORE_MAX_DEPTH;
const MAX_STATE_LEAF_INDEX = 2 ** STATE_MAX_DEPTH;

/** Validates the constructor config shared by all contract interactors. */
export const ContractInteractorConfigSchema = z.object({
    contractAddress: AddressSchema,
});

/** Validates an ERC20 allowance query, generic over the chain's address type `TAddress`. */
export function makeAllowanceArgsSchema<TAddress>(addressSchema: z.ZodType<TAddress>) {
    return z.object({
        token: addressSchema,
        owner: addressSchema,
        spender: addressSchema,
    });
}

/** Validates an ERC20 allowance query. */
export const AllowanceArgsSchema = makeAllowanceArgsSchema(AddressSchema);

export const AssetConfigSchema = z.object({
    enabled: BooleanSchema,
    minAmount: BigIntSchema,
    vettingFeeBPS: BigIntSchema,
    maxRelayFee: BigIntSchema,
});

/** Validates decoded args from LeafInserted / LeafUpdated events. */
export const KeystoreEventLogArgsSchema = z.object({
    _leafIndex: z
        .bigint()
        .nonnegative("Leaf index must be non-negative")
        .refine((v) => v < BigInt(MAX_KEYSTORE_LEAF_INDEX), {
            message: `Leaf index exceeds keystore tree capacity (${MAX_KEYSTORE_LEAF_INDEX})`,
        })
        .transform((v) => Number(v)),
    _newLeaf: z.bigint().nonnegative("Leaf value must be non-negative"),
});

/** Validates decoded args from AuthPolicySet / AuthPolicyUpdated events. */
export const KeystoreAuthEventLogArgsSchema = z.object({
    _account: AddressSchema,
    _authDigest: z.bigint().nonnegative("authDigest must be non-negative"),
});

/** Validates decoded args from LeavesInserted events. */
export const LeavesInsertedEventArgsSchema = z.object({
    _newLeaves: z.array(z.bigint().nonnegative("Leaf value must be non-negative")),
    _startIndex: z
        .bigint()
        .nonnegative("Start index must be non-negative")
        .refine((v) => v < BigInt(MAX_STATE_LEAF_INDEX), {
            message: `Start index exceeds state tree capacity (${MAX_STATE_LEAF_INDEX})`,
        })
        .transform((v) => Number(v)),
});

/** Validates NoteData shape (hint + data). Used by both event parsing and relayer. */
export const NoteDataSchema = z.object({
    hint: HexSchema,
    data: HexSchema,
});

/** Validates decoded args from Ragequit events. */
export const RagequitEventArgsSchema = z.object({
    ragequitter: AddressSchema,
    asset: AddressSchema,
    commitment: z.bigint().nonnegative("Commitment must be non-negative"),
    nullifierHash: z.bigint().nonnegative("Nullifier hash must be non-negative"),
    label: z.bigint().nonnegative("Label must be non-negative"),
});

/** Validates decoded args from Deposited events. */
export const DepositedEventArgsSchema = z.object({
    outputCommitment: z.bigint().nonnegative("Output commitment must be non-negative"),
    asset: AddressSchema,
    depositedValue: z.bigint().nonnegative("Deposited value must be non-negative"),
    caller: AddressSchema,
});

/** Validates decoded args from Transacted events. */
export const TransactedEventArgsSchema = z.object({
    outputCommitments: z.array(z.bigint().nonnegative("Output commitment must be non-negative")),
    nullifierHashes: z.array(z.bigint().nonnegative("Nullifier hash must be non-negative")),
    asset: AddressSchema,
    withdrawnValue: z.bigint().nonnegative("Withdrawn value must be non-negative"),
    caller: AddressSchema,
});
