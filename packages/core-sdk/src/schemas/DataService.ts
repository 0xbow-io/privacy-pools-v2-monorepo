import { z } from "zod";

import { Hex } from "../internal.js";

export const TxHashSchema = z
    .string()
    .regex(
        /^0x[0-9a-fA-F]{64}$/,
        "Must be a valid 32-byte hex-encoded transaction hash with 0x prefix",
    )
    .transform((value) => value as Hex);
