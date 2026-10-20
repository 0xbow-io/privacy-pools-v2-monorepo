/**
 * DEV-ONLY TOOLING — NOT SHIPPED SDK CODE.
 *
 * Standalone EVM mock ASP for exercising a browser/Angular integration against
 * `HttpASPDataProvider` locally, backed by an anvil fork of a live chain assumed to be already
 * running at RPC_URL. Replaces `evm-sdk/scripts/local-mock-asp/server.ts` (same defaults, same port).
 *
 * Run:   pnpm --filter @privacy-pools-v2/mock-asp start:evm
 * Check: curl http://127.0.0.1:3001/health
 *
 * Env: RPC_URL, MOCK_ASP_PORT, CHAIN_ID, ASP_REGISTRY_ADDRESS, ENTRYPOINT_ADDRESS (optional scope),
 *      POSTMAN_ADDRESS (impersonated) | POSTMAN_PRIVATE_KEY (local key), FORK_MODE=0 to disable retries.
 */
import type { Address } from "viem";

import type { Hex } from "@privacy-pools-v2/core-sdk";

import { startEvmMockAsp } from "../internal.js";

// Real Sepolia ASPRegistry and its POSTMAN_ROLE holder (verified on-chain via AccessRouter.hasRole).
const DEFAULT_ASP_REGISTRY = "0x35D29EFDCf067599ab4A53cf40229477f0b1cA9c";
const DEFAULT_POSTMAN = "0x723a43064e73Bcf46cf7d9b8506C400Df8ac878b";

const env = process.env;

async function main(): Promise<void> {
    const privateKey = env.POSTMAN_PRIVATE_KEY as Hex | undefined;
    const server = await startEvmMockAsp({
        rpcUrl: env.RPC_URL ?? "http://127.0.0.1:8545",
        chainId: Number(env.CHAIN_ID ?? 11155111),
        aspRegistryAddress: (env.ASP_REGISTRY_ADDRESS ?? DEFAULT_ASP_REGISTRY) as Address,
        entrypointAddress: env.ENTRYPOINT_ADDRESS as Address | undefined,
        signer: privateKey
            ? { kind: "privateKey", privateKey }
            : { kind: "impersonate", address: (env.POSTMAN_ADDRESS ?? DEFAULT_POSTMAN) as Address },
        forkMode: env.FORK_MODE !== "0",
        seedPublishedRoot: true,
        host: "127.0.0.1",
        port: Number(env.MOCK_ASP_PORT ?? 3001),
        log: (line) => console.log(line),
    });
    console.log(`[mock-asp] ASP public key: ${server.publicKeyHex}`);
}

main().catch((error: unknown) => {
    console.error("[mock-asp] fatal error during startup", error);
    process.exit(1);
});
