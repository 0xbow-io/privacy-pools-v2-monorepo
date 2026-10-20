/**
 * Runs ONCE per `vitest run`, before any test file. Starts (or reuses) the shared infrastructure —
 * the local Soroban network + deployed contracts, the relayer, and the mock ASP — so test files
 * never redeploy anything. Only connection info crosses to the test workers (`provide` accepts
 * serializable values only), so files reach the ASP over HTTP, exactly like the SDK under test
 * does. Mirrors `packages/evm-sdk/e2e/setup/global-setup.ts`.
 */
import { defineChainGlobalSetup } from "@privacy-pools-v2/e2e-suite/setup";

import type { E2EProvided } from "../harness/context.js";
import { MockAspServer } from "../mockAspServer.js";
import { ensureDeployed, fundViaFriendbot } from "../network.js";
import { ensureRelayerRunning } from "../relayer.js";

export default defineChainGlobalSetup<E2EProvided>({
    // Key the workers `inject` (see `harness/context.ts`).
    id: "e2e",
    // Inert without the opt-in, mirroring `describe.skipIf(!STELLAR_E2E)` in the test files. Read
    // from the env directly: `harness/context.ts` imports vitest's runtime, which a globalSetup
    // must not.
    enabled: process.env.STELLAR_E2E === "1",
    async start() {
        const network = await ensureDeployed();
        const { relayer, stopRelayer } = await ensureRelayerRunning(network);

        // Funded once for the whole run: the relayer pays Soroban resource fees for relayed txs.
        await fundViaFriendbot(relayer.address);

        const asp = await MockAspServer.create({ network });

        // The local network itself is left running between runs, same as before — no
        // `stopAnvil`-equivalent teardown here (matches the retired ad-hoc harness's own doc
        // comment: stop it manually with `packages/contracts-stellar/scripts/local-stellar.sh
        // stop`). The relayer process is torn down when this run started it and KEEP_ALIVE is off.
        return {
            handle: { network, relayer, aspUrl: asp.url },
            stop: async () => {
                await asp.stop();
                await stopRelayer?.();
            },
        };
    },
});
