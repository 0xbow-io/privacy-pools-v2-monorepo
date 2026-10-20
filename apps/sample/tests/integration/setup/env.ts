import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import type { Hex } from "@privacy-pools-v2/evm-sdk";

const hexString = z.string().regex(/^0x[0-9a-fA-F]+$/, "Invalid hex string");

const envSchema = z.object({
    RPC_URL: z.string().url(),
    CHAIN_ID: z.coerce.number().int().positive(),
    FAUCET_PRIVATE_KEY: hexString,
    POSTMAN_ROLE_PK: hexString,
    ENTRYPOINT_ADDRESS: hexString,
    KEYSTORE_ADDRESS: hexString,
    POOL_ADDRESS: hexString,
    ASP_REGISTRY_ADDRESS: hexString,
    ASP_PUBLIC_KEY: hexString,
    RELAYER_URL: z.string().url(),
    RELAYER_ADDRESS: hexString,
    RELAYER_PROCESSOR_ADDRESS: hexString,
});

export type TestConfig = {
    rpcUrl: string;
    chainId: number;
    faucetPrivateKey: Hex;
    postmanPrivateKey: Hex;
    entrypointAddress: Hex;
    keystoreAddress: Hex;
    poolAddress: Hex;
    aspRegistryAddress: Hex;
    aspPublicKey: Hex;
    /** Native ETH asset address used by the protocol. */
    tokenId: Hex;
    relayerUrl: string;
    relayerAddress: Hex;
    relayerProcessorAddress: Hex;
};

/** ETH native asset address used by Privacy Pools contracts. */
const NATIVE_ASSET_ADDRESS =
    "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Hex;

let cached: TestConfig | undefined;

/**
 * Loads and validates the integration test `.env` file.
 * Caches the result so repeated calls are free.
 */
export function loadTestConfig(): TestConfig {
    if (cached) return cached;

    loadDotenv({ path: resolve(import.meta.dirname, "..", ".env") });

    const parsed = envSchema.parse(process.env);

    cached = {
        rpcUrl: parsed.RPC_URL,
        chainId: parsed.CHAIN_ID,
        faucetPrivateKey: parsed.FAUCET_PRIVATE_KEY as Hex,
        postmanPrivateKey: parsed.POSTMAN_ROLE_PK as Hex,
        entrypointAddress: parsed.ENTRYPOINT_ADDRESS as Hex,
        keystoreAddress: parsed.KEYSTORE_ADDRESS as Hex,
        poolAddress: parsed.POOL_ADDRESS as Hex,
        aspRegistryAddress: parsed.ASP_REGISTRY_ADDRESS as Hex,
        aspPublicKey: parsed.ASP_PUBLIC_KEY as Hex,
        tokenId: NATIVE_ASSET_ADDRESS,
        relayerUrl: parsed.RELAYER_URL,
        relayerAddress: parsed.RELAYER_ADDRESS as Hex,
        relayerProcessorAddress: parsed.RELAYER_PROCESSOR_ADDRESS as Hex,
    };

    return cached;
}
