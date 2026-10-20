import { beforeAll, describe, expect, it } from "vitest";

import type { Address } from "../../src/internal.js";
import { MAX_BATCH } from "../../src/internal.js";
import type { E2EContext } from "../harness/context.js";
import { e2eContext, EVM_E2E } from "../harness/context.js";

const RELAY_ABI = [
    {
        name: "MAX_BATCH",
        type: "function",
        stateMutability: "pure",
        inputs: [],
        outputs: [{ name: "_maxBatch", type: "uint256" }],
    },
] as const;

/** The EVM-only rung of the batch-withdraw ladder; the rest lives in `@privacy-pools-v2/e2e-suite`. */
describe.skipIf(!EVM_E2E)("batch withdraw", () => {
    let ctx: E2EContext;

    beforeAll(() => {
        ctx = e2eContext();
    });

    it("agree with the relay contract on the maximum batch size", async () => {
        // The SDK constant mirrors a Solidity constant that is bounded by the pool's root history; if
        // they drift, the SDK would build batches the contract refuses (or refuse ones it accepts).
        const onChain = await ctx.publicClient.readContract({
            address: ctx.network.privacyPoolRelayAddress as Address,
            abi: RELAY_ABI,
            functionName: "MAX_BATCH",
        });

        expect(onChain).toBe(BigInt(MAX_BATCH));
    });
});
