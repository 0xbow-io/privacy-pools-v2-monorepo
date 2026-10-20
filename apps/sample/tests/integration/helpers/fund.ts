import { createPublicClient, formatEther, http, parseGwei } from "viem";
import { sepolia } from "viem/chains";
import type { Hex } from "@privacy-pools-v2/evm-sdk";

import type { TestActor, TestContext } from "./types.js";
import { removePersistedActor } from "./recovery.js";

/**
 * Transfers ETH from the faucet wallet to a test actor.
 */
export async function fundActor(
    actor: TestActor,
    amount: bigint,
    ctx: TestContext,
): Promise<void> {
    const txHash = await ctx.faucetWallet.sendTransaction({
        to: actor.address as `0x${string}`,
        value: amount,
        chain: sepolia,
    });

    await ctx.rpcInteractor.waitForTransactionReceipt(txHash as Hex);

    console.log(`  [${actor.name}] Funded with ${formatEther(amount)} ETH`);
}

/**
 * Sends all remaining ETH from a test actor back to the faucet.
 * Subtracts an estimated gas cost to avoid "insufficient funds" errors.
 * No-op if balance is too low to cover gas.
 */
export async function returnFundsToFaucet(
    actor: TestActor,
    ctx: TestContext,
): Promise<void> {
    const client = createPublicClient({
        chain: sepolia,
        transport: http(ctx.config.rpcUrl),
    });

    const balance = await client.getBalance({
        address: actor.address as `0x${string}`,
    });

    // Estimate gas for a simple ETH transfer (21000 gas) with generous gas price
    const gasCost = 21_000n * parseGwei("50");

    if (balance <= gasCost) {
        // Nothing to return — remove from recovery file anyway
        removePersistedActor(actor.address);
        console.log(
            `  [${actor.name}] Balance too low to return (${formatEther(balance)} ETH)`,
        );
        return;
    }

    const amountToReturn = balance - gasCost;

    const txHash = await actor.walletClient.sendTransaction({
        to: ctx.faucetAddress as `0x${string}`,
        value: amountToReturn,
        chain: sepolia,
    });

    await ctx.rpcInteractor.waitForTransactionReceipt(txHash as Hex);

    // Actor's funds recovered — remove from recovery file
    removePersistedActor(actor.address);

    console.log(
        `  [${actor.name}] Returned ${formatEther(amountToReturn)} ETH to faucet`,
    );
}
