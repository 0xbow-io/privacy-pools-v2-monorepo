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

describe("Scenario 4: Alice partial transfer to Bob + withdraw remaining", () => {
    useSequentialDeps();

    let ctx: TestContext;
    let alice: TestActor;
    let bob: TestActor;
    let depositLabel: Hash;
    let transferResult: TransferResult;

    const DEPOSIT_AMOUNT = parseEther("0.001");
    const TRANSFER_AMOUNT = parseEther("0.0005");

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

    test("Alice register keystore", async () => {
        await registerKeystore(alice);
    });

    test("Alice deposit 0.001 ETH", async () => {
        const result = await deposit(alice, DEPOSIT_AMOUNT, ctx);

        depositLabel = result.label;
        expect(result.commitment).toBeDefined();
    });

    test("activate deposit in ASP", async () => {
        await activateDeposit(depositLabel, [alice, bob], ctx);
    });

    test("Bob register keystore", async () => {
        await registerKeystore(bob);
    });

    test("Alice transfer 0.0005 ETH to Bob", async () => {
        // Transfer output notes inherit the input's label — no separate ASP activation needed
        transferResult = await transfer(alice, bob, TRANSFER_AMOUNT, ctx);

        expect(transferResult.recipientCommitment).toBeDefined();
        expect(transferResult.changeCommitment).toBeDefined();
    });

    test("Alice withdraw remaining balance (post relayer fee)", async () => {
        // Alice's change note value = (deposit - transfer - relayer fee).
        // The relayer deducted its fee from the change note during relayTransfer,
        // so we withdraw exactly what's left — not a hardcoded amount.
        await activateDeposit([], [alice], ctx);

        const result = await withdraw(alice, transferResult.changeValue, ctx);

        expect(result.amountOut).toBeDefined();
    });
});
