import { fileURLToPath } from "node:url";

import { Keypair } from "@stellar/stellar-sdk";

import type { Hex } from "../../src/internal.js";
import { addressScVal } from "../../src/internal.js";
import type { E2EContext } from "./context.js";
import { NETWORK_MODE } from "../network.js";

export const CIRCUIT_ARTIFACTS_DIR = fileURLToPath(new URL("../../../circuits/build", import.meta.url));

/**
 * Generous upper bound on one Soroban transaction's base + resource fee. Self-submitted
 * deposits/withdrawals pay it from the same account being asserted on, so an exact balance check
 * would be flaky. 0.5 XLM covers it without masking a wrong-amount bug. Matches the retired
 * `scripts/e2e-stellar/stellar-e2e.test.ts`'s own `FEE_CEILING`.
 */
export const FEE_CEILING = 5_000_000n;

/**
 * A brief settle: unlike EVM's anvil (`finalized = latest - 64`), Soroban has no separate
 * "finalized" head to wait past — a local standalone network has no reorg risk once a transaction
 * confirms (`waitForTransactionReceipt` already waits for `SUCCESS`). This only covers the RPC's
 * own event-indexer catching up to the just-closed ledger before the next `getEvents`/discovery scan.
 * Locally it waits until the RPC reports one more ledger than when called (about a second; it used to
 * be a fixed 3 s); testnet closes one roughly every 5-6 s, so `STELLAR_E2E_NETWORK=testnet` waits a
 * fixed 8 s for a full ledger close plus indexer catch-up.
 */
export async function settleFinality(ctx: E2EContext): Promise<void> {
    if (NETWORK_MODE === "testnet") {
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        return;
    }
    const start = BigInt(await ctx.rpcInteractor.getLatestLedger());
    const deadline = Date.now() + 15_000;
    while (BigInt(await ctx.rpcInteractor.getLatestLedger()) <= start) {
        if (Date.now() > deadline) throw new Error(`no ledger closed after ${start} within 15 s`);
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

/** The current ledger sequence, as the `fromBlock` for a file's `discoverNotes()` calls. */
export async function captureFromBlock(ctx: E2EContext): Promise<Hex> {
    return ctx.rpcInteractor.getLatestLedger();
}

/**
 * Reads a Stellar account's balance of `tokenAddress` via that SAC's `balance` entrypoint.
 *
 * `simulateRead`'s `sourcePublicKey` is just the account the RPC attributes simulation resource
 * fees to — it does not need to be (and must not be) `address` itself: `address` is frequently a
 * contract (e.g. the pool, when checking its held balance), and only a real funded classic
 * account can source a simulation. Uses the deploy admin, the same always-funded account
 * `publishedAspRoot()` already uses for the same reason.
 */
export async function balanceOf(ctx: E2EContext, address: string, tokenAddress: string): Promise<bigint> {
    const adminAddress = Keypair.fromSecret(ctx.network.adminSecret).publicKey();
    const raw = await ctx.rpcInteractor.simulateRead(tokenAddress, "balance", [addressScVal(address)], adminAddress);
    return raw as bigint;
}
