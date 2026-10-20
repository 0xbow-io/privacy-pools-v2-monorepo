import { z } from "zod";

import { STATE_MAX_DEPTH } from "../constant/index.js";
import { HexSchema } from "./common.js";

// Coarse upper bound, keyed off the deepest supported tree (state, depth 22). This service is
// shared across the state, keystore, and ASP trees, so the cap has to clear the largest one —
// it is a sanity backstop, not a tight DoS guard. The path that ingests untrusted leaves over
// HTTP (ASPClient) enforces its own tighter 2**ASSOCIATION_SET_MAX_DEPTH cap before this runs.
const MAX_LEAVES = 2 ** STATE_MAX_DEPTH;

export const LeavesSchema = z
    .array(HexSchema)
    .min(1, "At least one leaf is required")
    .max(MAX_LEAVES, `At most ${MAX_LEAVES} leaves are allowed`);

export const MerkleProofSchema = z.object(
    {
        leaf: HexSchema,
        root: HexSchema,
        siblings: z
            .array(HexSchema)
            .max(STATE_MAX_DEPTH, `A proof has at most ${STATE_MAX_DEPTH} siblings`),
        index: z.number().gte(0),
    },
    "Must be a valid Merkle proof",
);
