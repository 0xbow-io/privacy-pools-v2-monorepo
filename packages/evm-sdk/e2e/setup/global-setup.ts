/**
 * Runs ONCE per `vitest run`, before any test file. Starts (or reuses) the shared infrastructure —
 * per worker lane (see `lanes.ts`) an anvil holding the deployed contracts, a relayer and a mock
 * ASP — so test files never redeploy anything.
 * Only connection info crosses to the test workers (`provide` accepts serializable values only), so
 * files reach the ASP over HTTP, exactly like the SDK under test does. The opt-in guard, `provide`
 * plumbing and teardown wiring come from `@privacy-pools-v2/e2e-suite`'s `defineChainGlobalSetup`.
 */
import { defineChainGlobalSetup } from "@privacy-pools-v2/e2e-suite/setup";

import type { Address } from "../../src/internal.js";
import type { E2EProvided } from "../harness/context.js";
import { laneCount } from "../lanes.js";
import { MockAspServer } from "../mockAspServer.js";
import { ensureDeployed, fundAddress } from "../network.js";
import { ensureRelayersRunning } from "../relayer.js";

export default defineChainGlobalSetup<E2EProvided>({
    // Key the workers `inject` (see `harness/context.ts`).
    id: "e2e",
    // Inert without the opt-in, mirroring `describe.skipIf(!EVM_E2E)` in the test files. Read from the
    // env directly: `harness/context.ts` imports vitest's runtime, which a globalSetup must not.
    enabled: process.env.EVM_E2E === "1",
    async start() {
        const { networks, stopAnvils } = await ensureDeployed(laneCount());
        const { lanes, stopRelayers } = await ensureRelayersRunning(networks).catch(async (error: unknown) => {
            await stopAnvils();
            throw error;
        });

        // Funded once for the whole run: each relayer pays gas for relayed txs, and each MockRouter
        // forwards native ETH into the embedded Entrypoint.deposit() on the swap-and-deposit leg.
        await Promise.all(
            lanes.flatMap(({ network, relayer }) => [
                fundAddress(network.rpcUrl, relayer.address),
                fundAddress(network.rpcUrl, network.mockRouterAddress as Address),
            ]),
        );

        const served = await Promise.all(
            lanes.map(async (lane) => ({ ...lane, asp: await MockAspServer.create({ network: lane.network }) })),
        );

        // Stops only what this run started (`EVM_E2E_KEEP_ALIVE=1` leaves the anvils/relayers running).
        return {
            handle: { lanes: served.map(({ network, relayer, asp }) => ({ network, relayer, aspUrl: asp.url })) },
            stop: async () => {
                await Promise.all(served.map(({ asp }) => asp.stop()));
                await stopRelayers();
                await stopAnvils();
            },
        };
    },
});
