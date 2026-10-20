import { createPublicClient, http, formatEther } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { loadTestConfig } from "./env.js";
import {
    hasPendingRecovery,
    recoverFundsFromPreviousRun,
    registerSigintHandler,
} from "../helpers/recovery.js";

/**
 * Vitest globalSetup — runs once before all test files.
 * 1. Recovers funds from any previously crashed run
 * 2. Validates RPC connectivity and faucet balance
 * 3. Registers SIGINT handler for emergency recovery
 */
export async function setup(): Promise<void> {
    const config = loadTestConfig();

    // ── Step 1: Recover funds from a previous crashed run ────────────────
    if (hasPendingRecovery()) {
        await recoverFundsFromPreviousRun(config);
    }

    // ── Step 2: Verify RPC and faucet balance ────────────────────────────
    const client = createPublicClient({
        chain: sepolia,
        transport: http(config.rpcUrl),
    });

    const blockNumber = await client.getBlockNumber();
    console.log(`\n[global-setup] RPC connected — block #${blockNumber}`);

    const faucetAccount = privateKeyToAccount(config.faucetPrivateKey as `0x${string}`);
    const balance = await client.getBalance({ address: faucetAccount.address });
    const balanceEth = formatEther(balance);
    console.log(`[global-setup] Faucet ${faucetAccount.address} — ${balanceEth} ETH`);

    const MIN_BALANCE = 150_000_000_000_000_000n; // 0.15 ETH
    if (balance < MIN_BALANCE) {
        throw new Error(
            `Faucet balance too low: ${balanceEth} ETH. Need at least 0.15 ETH.`,
        );
    }

    // ── Step 3: Register SIGINT handler ──────────────────────────────────
    registerSigintHandler(config);

    console.log("[global-setup] Pre-flight checks passed.\n");
}
