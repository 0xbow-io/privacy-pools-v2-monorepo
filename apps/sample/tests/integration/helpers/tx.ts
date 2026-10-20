import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import type { Hex, ViemRPCInteractor } from "@privacy-pools-v2/evm-sdk";

import type { BoundWalletClient } from "./types.js";

export type TxParams = {
    to: Hex;
    data?: Hex;
    value?: bigint;
};

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 3_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simulates a transaction via `eth_call` to capture a detailed revert reason.
 * Only called after all retries are exhausted.
 */
async function simulateForDetailedError(
    txParams: TxParams,
    rpcUrl: string,
    label: string,
): Promise<string | null> {
    try {
        const publicClient = createPublicClient({
            chain: sepolia,
            transport: http(rpcUrl),
        });

        await publicClient.call({
            to: txParams.to as `0x${string}`,
            data: txParams.data as `0x${string}`,
            value: txParams.value ?? 0n,
        });

        console.warn(`  [simulate] ${label} — call succeeded, failure was likely transient`);
        return null;
    } catch (simError) {
        const simMsg = (simError as Error).message ?? String(simError);
        console.error(`  [simulate] ${label} — revert details:\n${simMsg}`);
        return simMsg;
    }
}

/**
 * Sends a transaction with automatic retries and exponential backoff.
 *
 * - Only retries the send phase (gas estimation / submission).
 * - Does NOT retry after the tx is submitted (avoids nonce issues).
 * - On final send failure, simulates via `eth_call` if `rpcUrl` is provided
 *   to capture the detailed revert reason.
 */
export async function sendAndConfirm(
    walletClient: BoundWalletClient,
    txParams: TxParams,
    rpcInteractor: ViemRPCInteractor,
    label = "tx",
    rpcUrl?: string,
): Promise<{ txHash: Hex; blockNumber: Hex }> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        let txHash: Hex;

        try {
            txHash = (await walletClient.sendTransaction({
                to: txParams.to as `0x${string}`,
                data: txParams.data as `0x${string}`,
                value: txParams.value ?? 0n,
            })) as Hex;
        } catch (error) {
            lastError = error as Error;

            if (attempt < MAX_RETRIES) {
                const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
                console.warn(
                    `  [retry] ${label} — attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay / 1000}s...`,
                );
                console.warn(`  [retry] ${lastError.message?.slice(0, 200)}`);
                await sleep(delay);
            }

            continue;
        }

        // Tx submitted successfully — wait for receipt (no retries from here)
        const receipt = await rpcInteractor.waitForTransactionReceipt(txHash);

        if (!receipt.status) {
            throw new Error(`[${label}] Transaction mined but reverted: ${txHash}`);
        }

        return { txHash, blockNumber: receipt.blockNumber };
    }

    // All retries exhausted — simulate to capture detailed error
    console.error(
        `  [retry] ${label} — all ${MAX_RETRIES} attempts failed.`,
    );

    if (rpcUrl) {
        const simMsg = await simulateForDetailedError(txParams, rpcUrl, label);
        if (simMsg) {
            lastError = new Error(
                `[${label}] Failed after ${MAX_RETRIES} retries.\n` +
                    `Last error: ${lastError?.message?.slice(0, 500)}\n` +
                    `Simulation: ${simMsg}`,
            );
        }
    }

    throw lastError!;
}
