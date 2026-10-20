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
    withdraw,
    activateDeposit,
} from "../helpers/operations.js";
import { cleanupAllActors } from "../helpers/cleanup.js";
import { useSequentialDeps } from "../helpers/depends.js";
import type { Hash } from "@privacy-pools-v2/evm-sdk";
import type { TransferResult } from "../helpers/types.js";

describe("Scenario 5: Alice transfers to Bob AND Fred, then withdraws remaining", () => {
    useSequentialDeps();

    let ctx: TestContext;
    let alice: TestActor;
    let bob: TestActor;
    let fred: TestActor;
    let depositLabel: Hash;
    let lastTransferResult: TransferResult;

    const DEPOSIT_AMOUNT = parseEther("0.001");
    const TRANSFER_TO_BOB = parseEther("0.0003");
    const TRANSFER_TO_FRED = parseEther("0.0003");

    beforeAll(async () => {
        ctx = await createTestContext();

        alice = createTestActor("alice", ctx);
        bob = createTestActor("bob", ctx);
        fred = createTestActor("fred", ctx);

        await createTestSession(alice, ctx);
        await createTestSession(bob, ctx);
        await createTestSession(fred, ctx);

        await fundActor(alice, parseEther("0.02"), ctx);
        await fundActor(bob, parseEther("0.01"), ctx);
        await fundActor(fred, parseEther("0.01"), ctx);
    });

    afterAll(async () => {
        await cleanupAllActors(ctx);
    });

    test("Alice register keystore", async () => {
        await registerKeystore(alice);
    });

    test("Alice deposit 0.001 ETH", async () => {
        const result = await deposit(alice, DEPOSIT_AMOUNT, ctx);

        depositLabel = result.label;
        expect(result.commitment).toBeDefined();
    });

    test("activate deposit in ASP", async () => {
        await activateDeposit(depositLabel, [alice, bob, fred], ctx);
    });

    test("Bob and Fred register keystores", async () => {
        await registerKeystore(bob);
        await registerKeystore(fred);
    });

    test("Alice transfer 0.0003 ETH to Bob", async () => {
        // Output notes inherit the deposit label — no extra ASP activation
        const result = await transfer(alice, bob, TRANSFER_TO_BOB, ctx);

        expect(result.recipientCommitment).toBeDefined();
        expect(result.changeCommitment).toBeDefined();

        // Refresh Alice's session so she can use the change note for next transfer
        await activateDeposit([], [alice], ctx);
    });

    test("Alice transfer 0.0003 ETH to Fred", async () => {
        lastTransferResult = await transfer(alice, fred, TRANSFER_TO_FRED, ctx);

        expect(lastTransferResult.recipientCommitment).toBeDefined();
        expect(lastTransferResult.changeCommitment).toBeDefined();

        // Refresh Alice again for the withdraw
        await activateDeposit([], [alice], ctx);
    });

    test("Alice withdraw remaining balance (post relayer fees)", async () => {
        // After two transfers, Alice's change note value = deposit - bob - fred - 2 * relayerFee
        const result = await withdraw(alice, lastTransferResult.changeValue, ctx);

        expect(result.amountOut).toBeDefined();
    });
});
