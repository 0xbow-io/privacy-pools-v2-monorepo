import { describe, test, beforeAll, afterAll, expect } from "vitest";
import { parseEther } from "viem";

import type { TestActor, TestContext } from "../helpers/types.js";
import { createTestContext } from "../helpers/context.js";
import { createTestActor } from "../helpers/account.js";
import { createTestSession } from "../helpers/session.js";
import { fundActor } from "../helpers/fund.js";
import { registerKeystore, deposit, ragequit } from "../helpers/operations.js";
import { cleanupAllActors } from "../helpers/cleanup.js";
import { useSequentialDeps } from "../helpers/depends.js";
import type { Hash } from "@privacy-pools-v2/evm-sdk";

describe("Scenario 1: register -> deposit -> ragequit", () => {
    useSequentialDeps();

    let ctx: TestContext;
    let alice: TestActor;
    let depositCommitment: Hash;

    beforeAll(async () => {
        ctx = await createTestContext();
        alice = createTestActor("alice", ctx);
        await createTestSession(alice, ctx);
        await fundActor(alice, parseEther("0.02"), ctx);
    });

    afterAll(async () => {
        await cleanupAllActors(ctx);
    });

    test("Alice register keystore", async () => {
        await registerKeystore(alice);

        const isRegistered = await alice.poolSession.isKeystoreRegistered();
        expect(isRegistered).toBe(true);
    });

    test("Alice deposit 0.001 ETH", async () => {
        const result = await deposit(alice, parseEther("0.001"), ctx);

        depositCommitment = result.commitment;
        expect(depositCommitment).toBeDefined();
    });

    test("Alice ragequit", async () => {
        await ragequit(alice, depositCommitment);

        const exported = alice.poolSession.exportAccount();
        const note = exported.notes.find(
            (n) => n.commitment === depositCommitment,
        );
        expect(note).toBeDefined();
        expect(note!.status).toBe("EXITED");
    });
});
