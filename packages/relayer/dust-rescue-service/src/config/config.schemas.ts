import { z } from "zod";
import { getAddress, type Address } from "viem";

export const zEvmAddress = z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .length(42)
    .transform((v): Address => getAddress(v));

export const zHexString = z
    .string()
    .regex(/^0x[0-9a-fA-F]*$/)
    .transform((v) => v as `0x${string}`);

export const zNonNegativeBigInt = z
    .union([z.string(), z.number(), z.bigint()])
    .pipe(z.coerce.bigint())
    .refine((v) => v >= 0n, "must be non-negative")
    .transform((v) => v as bigint);

/**
 * Per-destination-chain config. Deliberately independent of the relayer's
 * `zConfig`/`ChainConfigWrapper` — this is a separately deployed service with its
 * own concerns (see dust_collection_service_detailed_design.org §2), not a chain
 * config the relayer also needs.
 */
export const zDustRescueChainConfig = z.object({
    chainId: z.coerce.number().int().positive(),
    rpcUrl: z.string().url(),
    aspUrl: z.string().url(),
    circuitArtifactsDir: z.string().min(1),
    // Falls back to @privacy-pools-v2/evm-sdk's DEPLOYMENTS[chainId] when omitted, exactly
    // like dust-rescue-prover's own resolveDeployment().
    deployment: z
        .object({
            poolAddress: zEvmAddress,
            entrypointAddress: zEvmAddress,
            keystoreAddress: zEvmAddress,
            aspRegistryAddress: zEvmAddress,
        })
        .optional(),
    // Worth-it floor in micro-USD (1e-6 USD), per detailed design doc §4b — replaces an
    // earlier per-tokenId wei array. Chain-level, not asset-level: the dominant cost term
    // (gas) is chain-specific, and the relayer already prices the swept asset in USD at
    // registration time (see DustRescueJob.usdRate), so the threshold can live in the
    // same unit directly. Static, manually-refreshed for v1 (design doc §7/§8).
    minWorthUsdMicros: zNonNegativeBigInt,
});

export const zDustRescueConfig = z
    .object({
        chains: z.array(zDustRescueChainConfig),
        pubsubTopic: z.string().default("dust-rescue.pending"),
        firestoreCollection: z.string().default("dustRescueJobs"),
        sweepMaxAttempts: z.coerce.number().int().positive().default(5),
        // Caps how many non-terminal jobs one /sweep pass examines (finding #10, Problem
        // A) — sized from the per-job cost of a sweep (an ASP+RPC-bound detection check,
        // occasionally a full prove+submit), not a guess: 30 keeps a worst-case pass well
        // under Cloud Scheduler's period even if every job needs its expensive branch.
        sweepBatchSize: z.coerce.number().int().positive().default(30),
        // How long a leg may sit at genuine LiFi NOT_FOUND (indexing lag) before the job
        // gives up and retires FAILED (finding #10, Problem C) — hours, not minutes, so a
        // normal indexing delay is never mistaken for a dead transfer.
        notFoundAgeOutHours: z.coerce.number().positive().default(6),
    })
    .strict();

export type DustRescueChainConfig = z.infer<typeof zDustRescueChainConfig>;
export type DustRescueConfig = z.infer<typeof zDustRescueConfig>;
