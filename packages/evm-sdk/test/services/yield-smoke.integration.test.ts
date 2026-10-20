import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { Address, IRPCInteractor } from "../../src/internal.js";
import {
    PPRouterInteractor,
    PPYieldTokenInteractor,
    ViemRPCInteractor,
} from "../../src/internal.js";

/**
 * GATED on-chain smoke test for the yield interactors against a real local deployment.
 *
 * Skipped unless `YIELD_E2E=1` AND `docs/deployments.local.json` exists (produced by deploying the
 * stack to a local anvil Sepolia fork — see this dir's README). In this repo's default environment
 * both are absent, so it skips cleanly rather than passing vacuously or failing.
 *
 * When enabled it validates the read surface against the real deployed `PPRouter` / `PPYieldToken`:
 * quotes and ERC-4626 previews return sane, positive values. The full deposit→withdraw flow with
 * real proofs lives in the reference scripts (see README); this is the minimal on-chain check.
 */

const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";
const DEPLOYMENTS_PATH = resolve(__dirname, "../../../../docs/deployments.local.json");
const enabled = process.env.YIELD_E2E === "1" && existsSync(DEPLOYMENTS_PATH);

interface LocalDeployment {
    yield: { ppRouter: Address; ppUSDC: Address };
}

describe.skipIf(!enabled)("yield interactors (real local deployment)", () => {
    let rpc: IRPCInteractor;
    let router: PPRouterInteractor;
    let token: PPYieldTokenInteractor;

    beforeAll(() => {
        const dep = JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf8")) as LocalDeployment;
        rpc = ViemRPCInteractor.create({ rpcUrl: RPC_URL });
        router = new PPRouterInteractor({
            rpcInteractor: rpc,
            contractAddress: dep.yield.ppRouter,
        });
        token = new PPYieldTokenInteractor({
            rpcInteractor: rpc,
            contractAddress: dep.yield.ppUSDC,
        });
    });

    it("quotes the underlying needed for a share amount", async () => {
        const oneShare = 1_000_000_000_000_000_000n;
        const { underlyingNeeded } = await router.quote(oneShare);
        expect(underlyingNeeded).toBeGreaterThan(0n);
    });

    it("quoteWithdraw and previewRedeem agree in direction (both > 0 for a share amount)", async () => {
        const oneShare = 1_000_000_000_000_000_000n;
        const out = await router.quoteWithdraw(oneShare);
        const preview = await token.previewRedeem(oneShare);
        expect(out).toBeGreaterThan(0n);
        expect(preview).toBeGreaterThan(0n);
    });

    it("exposes a positive exchange rate", async () => {
        expect(await token.exchangeRate()).toBeGreaterThan(0n);
    });
});
