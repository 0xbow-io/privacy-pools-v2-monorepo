import { describe, test, beforeAll, afterAll, expect } from "vitest";
import { parseEther } from "viem";

import type { TestActor, TestContext } from "../helpers/types.js";
import { createTestContext } from "../helpers/context.js";
import { createTestActor } from "../helpers/account.js";
import { createTestSession } from "../helpers/session.js";
import { fundActor } from "../helpers/fund.js";
import {
    registerKeystore,
    deposit,
    transfer,
    activateDeposit,
} from "../helpers/operations.js";
import { cleanupAllActors } from "../helpers/cleanup.js";
import { useSequentialDeps } from "../helpers/depends.js";
import type { Hash } from "@privacy-pools-v2/evm-sdk";

describe("Scenario 3: Alice transfers ALL to Bob", () => {
    useSequentialDeps();

    let ctx: TestContext;
    let alice: TestActor;
    let bob: TestActor;
    let depositLabel: Hash;

    beforeAll(async () => {
        ctx = await createTestContext();

        alice = createTestActor("alice", ctx);
        bob = createTestActor("bob", ctx);

        await createTestSession(alice, ctx);
        await createTestSession(bob, ctx);

        await fundActor(alice, parseEther("0.02"), ctx);
        await fundActor(bob, parseEther("0.01"), ctx);
    });

    afterAll(async () => {
        await cleanupAllActors(ctx);
    });

    test("Alice deposit 0.001 ETH", async () => {
        const result = await deposit(alice, parseEther("0.001"), ctx);

        depositLabel = result.label;
        expect(result.commitment).toBeDefined();
    });

    test("Alice register keystore", async () => {
        await registerKeystore(alice);
    });

    test("activate deposit in ASP", async () => {
        await activateDeposit(depositLabel, [alice, bob], ctx);

        expect(ctx.aspLeaves.length).toBe(1);
    });

    test("Bob register keystore", async () => {
        await registerKeystore(bob);
    });

    test("Alice transfer nearly all to Bob (leaves room for relayer fee)", async () => {
        // In a real scenario, the relayer deducts its fee from the sender's change note.
        // A full-amount transfer (change = 0) is impossible because the relayer fee
        // would make the change negative. Transfer slightly less to cover the fee.
        const result = await transfer(alice, bob, parseEther("0.0009"), ctx);

        expect(result.recipientCommitment).toBeDefined();
        expect(result.changeCommitment).toBeDefined();
    });
});
