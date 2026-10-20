import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
    createPublicClient,
    createWalletClient,
    formatEther,
    http,
    parseGwei,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { Hex } from "@privacy-pools-v2/evm-sdk";

import type { TestConfig } from "../setup/env.js";

/** Persisted actor entry — minimal data needed to recover funds. */
type PersistedActor = {
    name: string;
    privateKey: string;
    address: string;
    createdAt: string;
};

const RECOVERY_FILE = resolve(import.meta.dirname, "..", ".recovery.json");

// ─── Read / Write ────────────────────────────────────────────────────────────

function readRecoveryFile(): PersistedActor[] {
    if (!existsSync(RECOVERY_FILE)) return [];
    try {
        return JSON.parse(readFileSync(RECOVERY_FILE, "utf-8")) as PersistedActor[];
    } catch {
        return [];
    }
}

function writeRecoveryFile(actors: PersistedActor[]): void {
    if (actors.length === 0) {
        // No actors left — delete the file entirely
        if (existsSync(RECOVERY_FILE)) {
            unlinkSync(RECOVERY_FILE);
        }
        return;
    }
    writeFileSync(RECOVERY_FILE, JSON.stringify(actors, null, 2));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Persists an actor's private key so funds can be recovered if the process dies.
 * Called when an actor is created and funded.
 */
export function persistActor(name: string, privateKey: Hex, address: Hex): void {
    const actors = readRecoveryFile();

    // Avoid duplicates
    if (actors.some((a) => a.address === address)) return;

    actors.push({
        name,
        privateKey,
        address,
        createdAt: new Date().toISOString(),
    });

    writeRecoveryFile(actors);
}

/**
 * Removes an actor from the recovery file after funds have been returned.
 */
export function removePersistedActor(address: Hex): void {
    const actors = readRecoveryFile();
    const filtered = actors.filter(
        (a) => a.address.toLowerCase() !== address.toLowerCase(),
    );
    writeRecoveryFile(filtered);
}

/**
 * Returns true if there are actors pending recovery from a previous run.
 */
export function hasPendingRecovery(): boolean {
    return readRecoveryFile().length > 0;
}

/**
 * Attempts to recover funds from actors left over by a crashed previous run.
 * Sends all ETH back to the faucet address.
 * Returns the number of actors successfully recovered.
 */
export async function recoverFundsFromPreviousRun(
    config: TestConfig,
): Promise<number> {
    const actors = readRecoveryFile();
    if (actors.length === 0) return 0;

    console.log(
        `\n  [recovery] Found ${actors.length} actor(s) from a previous crashed run.`,
    );

    const faucetAccount = privateKeyToAccount(config.faucetPrivateKey as `0x${string}`);
    const client = createPublicClient({
        chain: sepolia,
        transport: http(config.rpcUrl),
    });

    let recovered = 0;

    for (const actor of [...actors]) {
        try {
            const balance = await client.getBalance({
                address: actor.address as `0x${string}`,
            });

            const MAX_FEE_PER_GAS = parseGwei("50");
            const GAS_LIMIT = 21_000n;
            const gasCost = GAS_LIMIT * MAX_FEE_PER_GAS;

            if (balance <= gasCost) {
                console.log(
                    `  [recovery] ${actor.name} (${actor.address}) — no funds to recover (${formatEther(balance)} ETH)`,
                );
                removePersistedActor(actor.address as Hex);
                recovered++;
                continue;
            }

            const amountToReturn = balance - gasCost;
            const account = privateKeyToAccount(actor.privateKey as `0x${string}`);
            const walletClient = createWalletClient({
                account,
                chain: sepolia,
                transport: http(config.rpcUrl),
            });

            const txHash = await walletClient.sendTransaction({
                to: faucetAccount.address,
                value: amountToReturn,
                gas: GAS_LIMIT,
                maxFeePerGas: MAX_FEE_PER_GAS,
                chain: sepolia,
            });

            // Wait for confirmation
            await client.waitForTransactionReceipt({ hash: txHash });

            console.log(
                `  [recovery] ${actor.name} (${actor.address}) — returned ${formatEther(amountToReturn)} ETH to faucet`,
            );

            removePersistedActor(actor.address as Hex);
            recovered++;
        } catch (error) {
            console.warn(
                `  [recovery] Failed to recover funds from ${actor.name} (${actor.address}): ${error}`,
            );
            // Note: funds locked inside the contract (deposited) cannot be recovered
            // without rebuilding a full PoolSession + ragequit. Those are lost (0.001 ETH max).
            // We still remove the actor to avoid infinite retry loops.
            removePersistedActor(actor.address as Hex);
        }
    }

    console.log(
        `  [recovery] Done. Recovered ${recovered}/${actors.length} actor(s).\n`,
    );

    return recovered;
}

/**
 * Registers a SIGINT handler that attempts emergency fund recovery.
 * Should be called once during global setup.
 */
export function registerSigintHandler(config: TestConfig): void {
    let handling = false;

    process.on("SIGINT", async () => {
        if (handling) {
            // Second Ctrl+C — force exit
            console.log("\n  [recovery] Force exit.");
            process.exit(1);
        }

        handling = true;
        console.log(
            "\n\n  [recovery] SIGINT received — attempting emergency fund recovery...",
        );
        console.log(
            "  [recovery] Press Ctrl+C again to force exit.\n",
        );

        try {
            await recoverFundsFromPreviousRun(config);
        } catch (error) {
            console.warn(`  [recovery] Emergency recovery failed: ${error}`);
        }

        process.exit(1);
    });
}
