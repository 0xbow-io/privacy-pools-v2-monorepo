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
    importReceivedNote,
} from "../helpers/operations.js";
import { cleanupAllActors } from "../helpers/cleanup.js";
import { useSequentialDeps } from "../helpers/depends.js";
import type { Hash } from "@privacy-pools-v2/evm-sdk";
import type { TransferResult } from "../helpers/types.js";

describe("Scenario 6: Bidirectional transfer — Alice <-> Bob, then both withdraw", () => {
    useSequentialDeps();

    let ctx: TestContext;
    let alice: TestActor;
    let bob: TestActor;
    let depositLabel: Hash;
    let aliceToBobResult: TransferResult;
    let bobToAliceResult: TransferResult;

    const DEPOSIT_AMOUNT = parseEther("0.001");
    const ALICE_TO_BOB = parseEther("0.0005");
    const BOB_TO_ALICE = parseEther("0.0002");

    beforeAll(async () => {
        ctx = await createTestContext();

        alice = createTestActor("alice", ctx);
        bob = createTestActor("bob", ctx);

        await createTestSession(alice, ctx);
        await createTestSession(bob, ctx);

        await fundActor(alice, parseEther("0.02"), ctx);
        await fundActor(bob, parseEther("0.02"), ctx);
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

    test("activate Alice deposit in ASP", async () => {
        await activateDeposit(depositLabel, [alice, bob], ctx);
    });

    test("Bob register keystore", async () => {
        await registerKeystore(bob);
    });

    test("Alice transfer 0.0005 ETH to Bob", async () => {
        aliceToBobResult = await transfer(alice, bob, ALICE_TO_BOB, ctx);

        expect(aliceToBobResult.recipientCommitment).toBeDefined();

        // Bob needs to import the received note into his session
        await importReceivedNote(bob, aliceToBobResult);

        // Refresh both sessions to pick up latest state
        await activateDeposit([], [alice, bob], ctx);
    });

    test("Bob transfer 0.0002 ETH back to Alice", async () => {
        bobToAliceResult = await transfer(bob, alice, BOB_TO_ALICE, ctx);

        expect(bobToAliceResult.recipientCommitment).toBeDefined();

        // Alice imports the note Bob sent her
        await importReceivedNote(alice, bobToAliceResult);

        // Refresh both for withdrawals
        await activateDeposit([], [alice, bob], ctx);
    });

    test("Alice withdraw her change note balance", async () => {
        // Alice's change note value = (DEPOSIT - ALICE_TO_BOB - relayerFee)
        // She can only spend one note per withdraw — spend the change note
        const result = await withdraw(alice, aliceToBobResult.changeValue, ctx);

        expect(result.amountOut).toBeDefined();
    });

    test("Bob withdraw his change note balance", async () => {
        // Bob's change note value = (ALICE_TO_BOB - BOB_TO_ALICE - relayerFee)
        const result = await withdraw(bob, bobToAliceResult.changeValue, ctx);

        expect(result.amountOut).toBeDefined();
    });
});
