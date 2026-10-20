import { z } from "zod";

import { SUPPORTED_CHAIN_IDS } from "../constant/index.js";

// http(s) only. ViemRPCInteractor.create always builds an `http()` transport, so a ws/wss URL
// passes a looser check and then fails on the first RPC call. Reject it here instead.
export const RpcUrlSchema = z
    .url("Must be a valid URL")
    .refine((url) => /^https?:\/\//i.test(url), {
        message: "RPC URL must use http or https protocol",
    });

export const ChainSchema = z
    .object({
        id: z
            .number()
            .int()
            .positive("Chain ID must be a positive integer")
            .refine((id) => SUPPORTED_CHAIN_IDS.has(id), {
                message: "Unsupported chain ID",
            }),
        name: z.string().min(1, "Chain name must not be empty"),
    })
    .passthrough();
