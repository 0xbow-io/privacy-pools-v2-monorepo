import "dotenv/config";

import type { Hex } from "@privacy-pools-v2/evm-sdk";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function optionalEnv(name: string): string | undefined {
    return process.env[name] || undefined;
}

export const config = {
    rpcUrl: requireEnv("RPC_URL"),
    chainId: Number(requireEnv("CHAIN_ID")),
    tokenId: requireEnv("TOKEN_ID") as Hex,
    depositAmount: requireEnv("DEPOSIT_AMOUNT"),

    entrypointAddress: requireEnv("ENTRYPOINT_ADDRESS") as Hex,
    keystoreAddress: requireEnv("KEYSTORE_ADDRESS") as Hex,
    poolAddress: requireEnv("POOL_ADDRESS") as Hex,
    aspRegistryAddress: requireEnv("ASP_REGISTRY_ADDRESS") as Hex,

    aspUrl: requireEnv("ASP_URL"),
    aspPublicKey: optionalEnv("ASP_PUBLIC_KEY") as Hex | undefined,
    aspPrivateKey: optionalEnv("ASP_PRIVATE_KEY") as Hex | undefined,
    postmanRolePrivateKey: optionalEnv("POSTMAN_PK") as Hex | undefined,

    relayerUrl: requireEnv("RELAYER_URL"),
    relayerAddress: requireEnv("RELAYER_ADDRESS") as Hex,
    relayerProcessorAddress: requireEnv("RELAYER_PROCESSOR_ADDRESS") as Hex,

    bob: {
        privateKey: requireEnv("PRIVATE_KEY") as Hex,
        privateNullifyingKey: requireEnv("PRIVATE_NULLIFYING_KEY") as Hex,
        privateRevocableKey: requireEnv("PRIVATE_REVOCABLE_KEY") as Hex,
        viewingPrivateKey: requireEnv("VIEWING_PRIVATE_KEY") as Hex,
        viewingPublicKey: requireEnv("VIEWING_PUBLIC_KEY") as Hex,
    },

    alice: {
        address: optionalEnv("ALICE_ADDRESS") as Hex | undefined,
        privateKey: optionalEnv("ALICE_PRIVATE_KEY") as Hex | undefined,
        privateNullifyingKey: optionalEnv("ALICE_PRIVATE_NULLIFYING_KEY") as Hex | undefined,
        privateRevocableKey: optionalEnv("ALICE_PRIVATE_REVOCABLE_KEY") as Hex | undefined,
        viewingPrivateKey: optionalEnv("ALICE_VIEWING_PRIVATE_KEY") as Hex | undefined,
        viewingPublicKey: optionalEnv("ALICE_VIEWING_PUBLIC_KEY") as Hex | undefined,
    },
} as const;

export function requireAliceConfig(): {
    address: Hex;
    privateKey: Hex;
    privateNullifyingKey: Hex;
    privateRevocableKey: Hex;
    viewingPrivateKey: Hex;
    viewingPublicKey: Hex;
} {
    const {
        address,
        privateKey,
        privateNullifyingKey,
        privateRevocableKey,
        viewingPrivateKey,
        viewingPublicKey,
    } = config.alice;
    if (
        !address ||
        !privateKey ||
        !privateNullifyingKey ||
        !privateRevocableKey ||
        !viewingPrivateKey ||
        !viewingPublicKey
    ) {
        throw new Error(
            "Alice env vars are required for this example. Set ALICE_ADDRESS, ALICE_PRIVATE_KEY, " +
                "ALICE_PRIVATE_NULLIFYING_KEY, ALICE_PRIVATE_REVOCABLE_KEY, ALICE_VIEWING_PRIVATE_KEY, " +
                "ALICE_VIEWING_PUBLIC_KEY in apps/sample/.env (run `pnpm sample:createKeys` to generate fresh ones).",
        );
    }
    return {
        address,
        privateKey,
        privateNullifyingKey,
        privateRevocableKey,
        viewingPrivateKey,
        viewingPublicKey,
    };
}
