/**
 * DEV-ONLY TOOLING — NOT SHIPPED SDK CODE.
 *
 * Standalone Stellar mock ASP for exercising an integration against `HttpASPDataProvider`
 * locally, backed by a local Soroban network assumed to be already running at RPC_URL (see
 * `packages/contracts-stellar/scripts/local-stellar.sh`).
 *
 * Run:   pnpm --filter @privacy-pools-v2/mock-asp start:stellar
 * Check: curl http://127.0.0.1:3001/health
 *
 * Env: RPC_URL, NETWORK_PASSPHRASE, MOCK_ASP_PORT, CHAIN_ID, ASP_REGISTRY_CONTRACT_ID,
 *      ENTRYPOINT_ADDRESS (optional scope), POSTMAN_SECRET_KEY (the registry's postman identity).
 */
import { startStellarMockAsp } from "../internal.js";

const env = process.env;

async function main(): Promise<void> {
    const postmanSecretKey = env.POSTMAN_SECRET_KEY;
    if (!postmanSecretKey) {
        throw new Error("POSTMAN_SECRET_KEY is required (the asp-registry's configured postman identity)");
    }
    const aspRegistryContractId = env.ASP_REGISTRY_CONTRACT_ID;
    if (!aspRegistryContractId) {
        throw new Error("ASP_REGISTRY_CONTRACT_ID is required");
    }
    const server = await startStellarMockAsp({
        rpcUrl: env.RPC_URL ?? "http://localhost:8000/rpc",
        networkPassphrase: env.NETWORK_PASSPHRASE ?? "Standalone Network ; February 2017",
        chainId: Number(env.CHAIN_ID ?? 1),
        aspRegistryContractId,
        entrypointAddress: env.ENTRYPOINT_ADDRESS,
        signerSecretKey: postmanSecretKey,
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
