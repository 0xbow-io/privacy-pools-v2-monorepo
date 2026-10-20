/**
 * Parallel e2e. Test files can't share a chain: a proof must be built against the ASPRegistry's LATEST
 * root (`PoolVault_InvalidASPRoot` otherwise), so another file's ASP approval landing mid-proof breaks
 * it; the keystore root moves the same way, and mock ASP faults are global to its server. So each
 * vitest worker gets a lane of its own — an anvil started from the shared post-deploy snapshot (so
 * every lane has the same contracts at the same addresses), plus its own relayer and mock ASP. A
 * worker runs its files one after another, so a lane is never used by two files at once.
 */

/** Lane k's anvil listens on BASE_ANVIL_PORT + k. */
const BASE_ANVIL_PORT = 8545;

/** Workers (= lanes). `EVM_E2E_WORKERS=1` runs every file on one lane, one after another. */
export function laneCount(): number {
    const raw = process.env.EVM_E2E_WORKERS;
    const count = raw === undefined ? 4 : Number(raw);
    if (!Number.isInteger(count) || count < 1) throw new Error(`EVM_E2E_WORKERS must be a positive integer, got "${raw}"`);
    return count;
}

/** The RPC url of lane `lane`'s anvil. */
export function laneRpcUrl(lane: number): string {
    return `http://localhost:${BASE_ANVIL_PORT + lane}`;
}

/**
 * The calling test worker's lane out of `lanes`. vitest numbers its concurrently running workers
 * 1..maxWorkers (`VITEST_POOL_ID`), never giving one id to two live workers.
 */
export function currentLane<T>(lanes: readonly T[]): T {
    const lane = lanes[Number(process.env.VITEST_POOL_ID ?? "1") - 1];
    if (lane === undefined) {
        throw new Error(`worker VITEST_POOL_ID=${process.env.VITEST_POOL_ID} has no lane (${lanes.length} started)`);
    }
    return lane;
}
