import { fileURLToPath } from "node:url";

import type { Address, Hex, Note } from "../../src/internal.js";
import { bigintToHex } from "../../src/internal.js";
import type { E2EContext } from "./context.js";
import { MOCK_ERC20_ABI } from "./actors.js";

export const CIRCUIT_ARTIFACTS_DIR = fileURLToPath(new URL("../../../circuits/build", import.meta.url));
export const NATIVE_ASSET = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;

/**
 * Generous upper bound on one transaction's gas cost. Self-submitted deposits/withdrawals pay it from
 * the same account being asserted on, so an exact balance check would be flaky. 0.01 ETH covers it
 * without masking a wrong-amount bug.
 */
export const FEE_CEILING = 10_000_000_000_000_000n;

async function rpc(ctx: E2EContext, method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(ctx.network.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
}

/**
 * Mines past the finality boundary. Note discovery only writes a terminal status (SPENT / EXITED) for a
 * log at or below the node's `finalized` block, and anvil reports `finalized = latest - 64`, so a
 * just-mined spend stays unsettled until 64 more blocks exist.
 */
export async function settleFinality(ctx: E2EContext, blocks = 70): Promise<void> {
    await rpc(ctx, "anvil_mine", [`0x${blocks.toString(16)}`]);
}

/**
 * The current head block, as the `fromBlock` for a file's `discoverNotes()` calls. Scans start here
 * instead of at the deploy block, so they don't grow as the shared chain grows across files.
 * Capture it in `beforeAll`, before the file's first transaction.
 */
export async function captureFromBlock(ctx: E2EContext): Promise<Hex> {
    return bigintToHex(await ctx.publicClient.getBlockNumber());
}

/**
 * Discovers notes after settling finality, retrying a few times if the result is empty.
 * Observed on this local fork: a scan run right after a just-mined tx can briefly see nothing, then
 * find everything a beat later (the node's view of "current" lags `eth_getLogs`). Only retries on a
 * fully empty result — never seen a partial one.
 */
export async function discoverNotesWithRetry(
    ctx: E2EContext,
    session: { discoverNotes: (params: { fromBlock: Hex }) => Promise<Note<Address>[]> },
    fromBlock: Hex,
): Promise<Note<Address>[]> {
    await settleFinality(ctx);
    for (let attempt = 0; attempt < 5; attempt++) {
        const discovered = await session.discoverNotes({ fromBlock });
        if (discovered.length > 0) return discovered;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return session.discoverNotes({ fromBlock });
}

export function nativeBalance(ctx: E2EContext, address: Address): Promise<bigint> {
    return ctx.publicClient.getBalance({ address });
}

export function erc20Balance(ctx: E2EContext, token: Address, address: Address): Promise<bigint> {
    return ctx.publicClient.readContract({
        address: token,
        abi: MOCK_ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
    }) as Promise<bigint>;
}

export function erc20Allowance(ctx: E2EContext, token: Address, owner: Address, spender: Address): Promise<bigint> {
    return ctx.publicClient.readContract({
        address: token,
        abi: MOCK_ERC20_ABI,
        functionName: "allowance",
        args: [owner, spender],
    }) as Promise<bigint>;
}

/** Sets an account's native balance exactly (anvil cheat code) — e.g. to 0, to make it a gasless account. */
export async function setBalance(ctx: E2EContext, address: Address, wei: bigint): Promise<void> {
    await rpc(ctx, "anvil_setBalance", [address, `0x${wei.toString(16)}`]);
}
