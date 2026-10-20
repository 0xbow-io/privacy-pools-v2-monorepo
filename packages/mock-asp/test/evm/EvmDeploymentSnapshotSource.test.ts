import { afterEach, describe, expect, it } from "vitest";

import type { MockAspHttpServer } from "../../src/internal.js";
import { EvmDeploymentSnapshotSource } from "../../src/internal.js";
import { CHAIN_ID, FakePublisher, get, providerFor, startServer } from "../core/helpers.js";

describe("EvmDeploymentSnapshotSource", () => {
    let server: MockAspHttpServer | undefined;

    afterEach(async () => {
        await server?.stop();
        server = undefined;
    });

    it("serve an empty snapshot the client accepts, ending at the deployment block", async () => {
        server = await startServer({
            publisher: new FakePublisher(),
            eventSource: new EvmDeploymentSnapshotSource({ chainId: CHAIN_ID, deploymentBlock: "0x1234" }),
        });

        const snapshot = await providerFor(server).getEventSnapshot();

        expect(BigInt(snapshot.snapshotBlockNumber)).toBe(0x1234n);
        expect(BigInt(snapshot.chainId)).toBe(BigInt(CHAIN_ID));
        expect([snapshot.deposits, snapshot.transacts, snapshot.ragequits, snapshot.leaves]).toEqual([[], [], [], []]);
        expect(snapshot.drops).toBeUndefined();
    });

    it("leave note-events unimplemented so clients fall back to on-chain scanning", async () => {
        server = await startServer({
            publisher: new FakePublisher(),
            eventSource: new EvmDeploymentSnapshotSource({ chainId: CHAIN_ID, deploymentBlock: 1 }),
        });

        expect((await get(server, `/${CHAIN_ID}/public/note-events`)).status).toBe(501);
    });

    it("accept a bigint or decimal deployment block", async () => {
        const fromBigint = await new EvmDeploymentSnapshotSource({ chainId: 1, deploymentBlock: 99n }).getEventSnapshot();
        const fromNumber = await new EvmDeploymentSnapshotSource({ chainId: 1, deploymentBlock: 99 }).getEventSnapshot();

        expect(fromBigint.snapshotBlockNumber).toBe("99");
        expect(fromNumber.snapshotBlockNumber).toBe("99");
    });
});
