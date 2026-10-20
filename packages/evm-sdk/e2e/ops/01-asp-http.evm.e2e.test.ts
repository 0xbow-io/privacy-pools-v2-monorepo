import { beforeAll, describe, expect, it } from "vitest";

import { ASPUnavailable } from "../../src/internal.js";
import type { E2EContext } from "../harness/context.js";
import { e2eContext, EVM_E2E } from "../harness/context.js";
import { EvmDriver } from "../driver/EvmDriver.js";

/**
 * What only the EVM mock-ASP adapter promises: an honestly empty event snapshot through the deployment
 * block (the anvil fork cannot serve `eth_getLogs` from genesis) and unimplemented note events. The
 * rest of the ASP-over-HTTP ladder is in `@privacy-pools-v2/e2e-suite`'s `aspHttp` suite.
 */
describe.skipIf(!EVM_E2E)("asp over http", () => {
    let ctx: E2EContext;
    let provider: ReturnType<EvmDriver["aspProvider"]>;

    beforeAll(() => {
        ctx = e2eContext();
        provider = new EvmDriver(ctx).aspProvider();
    });

    it("serve an honestly empty event snapshot that ends at the deployment block", async () => {
        const snapshot = await provider.getEventSnapshot();

        expect(BigInt(snapshot.snapshotBlockNumber)).toBe(BigInt(ctx.network.deploymentBlock));
        expect(snapshot.deposits).toEqual([]);
        expect(snapshot.drops).toBeUndefined();
    });

    it("leave note events unimplemented so clients fall back to on-chain scanning", async () => {
        await expect(provider.getNoteEvents()).rejects.toThrow(ASPUnavailable);
    });
});
