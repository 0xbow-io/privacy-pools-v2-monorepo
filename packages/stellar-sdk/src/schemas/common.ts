import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

// Plain internal.js import (not a direct constant path): unlike the old packages/sdk/src's
// same-directory-evaluation-order hazard (EMPTY_ADDRESS re-exported late in that package's own
// constant/index.ts barrel, circularly reachable from this same module graph), EMPTY_ADDRESS
// here comes from @privacy-pools-v2/core-sdk — a separate, already-built package whose module
// graph is fully resolved before stellar-sdk's own internal.ts starts evaluating. No same-
// directory circular barrel is in play, so importing it through the barrel is safe.
import { EMPTY_ADDRESS } from "../internal.js";

/** Validates a Stellar StrKey address — either an account ("G...") or a contract ("C...") address. */
export const StellarAddressSchema = z
    .string()
    .refine((val) => StrKey.isValidEd25519PublicKey(val) || StrKey.isValidContract(val), {
        message: "Must be a valid Stellar StrKey account (G...) or contract (C...) address",
    });

/**
 * `StellarAddressSchema`, widened to also accept the chain-agnostic `EMPTY_ADDRESS` sentinel
 * (`"0x000...0"`, EVM-shaped but used throughout the SDK as an address-typed "N/A" placeholder —
 * e.g. a recipient's pending note's `ownerAddress`, unknown to the sender). Scoped to contexts
 * where the field is validated for shape only and never read for a real chain address (see
 * `WitnessPreparationService`'s `Note`/`PendingNote` array fields) — anywhere the value is
 * actually consumed as an address, a real `StellarAddressSchema` check is still correct.
 */
export const StellarAddressOrEmptySchema = z.union([StellarAddressSchema, z.literal(EMPTY_ADDRESS)]);
