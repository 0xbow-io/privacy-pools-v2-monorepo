import { z } from "zod";

import { MAX_INPUTS, MAX_OUTPUTS, MIN_INPUTS, MIN_OUTPUTS } from "../constant/index.js";
import { HexSchema } from "./common.js";

/** Validates that transact circuit dimensions (nInputs, mOutputs) are integers in [1, 5]. */
export const TransactDimensionsSchema = z.object({
    nInputs: z.number().int().min(MIN_INPUTS).max(MAX_INPUTS),
    mOutputs: z.number().int().min(MIN_OUTPUTS).max(MAX_OUTPUTS),
});

/** Validates that a witness is a non-empty record. */
export const CircuitInputsSchema = z
    .record(z.string(), z.unknown())
    .refine((obj) => Object.keys(obj).length > 0, "Witness must not be empty");

export const NumericStringSchema = z.string().regex(/^[0-9]+$/, "Must be a valid numeric string");

/** Validate Groth16 proof object. */
export const Groth16ProofSchema = z.object({
    pi_a: z.array(NumericStringSchema),
    pi_b: z.array(z.array(NumericStringSchema)),
    pi_c: z.array(NumericStringSchema),
    protocol: z.string(),
    curve: z.string(),
});

export const Groth16PublicSignalsSchema = z.array(NumericStringSchema);

/** Validates the shape of a Groth16 proof object. */
export const ProofSchema = z.object({
    pi_a: z.array(HexSchema),
    pi_b: z.array(z.array(HexSchema)),
    pi_c: z.array(HexSchema),
    protocol: z.string(),
    curve: z.string(),
});

/** Validates the shape of a proof result (proof + publicSignals). */
export const ProofResultSchema = z.object({
    proof: ProofSchema,
    publicSignals: z.array(HexSchema),
});
