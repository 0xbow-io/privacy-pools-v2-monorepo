import { describe, test, beforeAll, afterAll, expect, vi } from "vitest";
import { parseEther } from "viem";

import type {
  TestActor,
  TestContext,
  TransferResult,
} from "../helpers/types.js";
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
import {
  buildEventsFromTransferResult,
  buildSimulatedNoteEvent,
} from "../helpers/note-discovery.js";
import type {
  Address,
  Hash,
  Hex,
  NotePayload,
  PublicKey,
  Secret,
  NoteEvent,
} from "@privacy-pools-v2/evm-sdk";

/**
 * Stubs `getTransactEvents` on the actor's pool vault interactor to return
 * the given simulated events, then restores the original after discovery.
 */
async function discoverWithSimulatedEvents(
  actor: TestActor,
  events: NoteEvent[],
): Promise<Awaited<ReturnType<typeof actor.poolSession.discoverNotes>>> {
  const spy = vi
    .spyOn(actor.poolVaultInteractor, "getNoteEvents")
    .mockResolvedValueOnce(events);
  try {
    return await actor.poolSession.discoverNotes();
  } finally {
    spy.mockRestore();
  }
}

describe("Scenario 7: Note discovery — catch-all scan recovers transfer notes", () => {
  useSequentialDeps();

  let ctx: TestContext;
  let alice: TestActor;
  let bob: TestActor;
  let depositLabel: Hash;

  // Transfer results captured for building simulated events
  let transfer1Result: TransferResult;
  let transfer2Result: TransferResult;

  const DEPOSIT_AMOUNT = parseEther("0.005");
  const TRANSFER_1_AMOUNT = parseEther("0.002");
  const TRANSFER_2_AMOUNT = parseEther("0.001");

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

  // ─── Setup: Register, Deposit, Activate ─────────────────────────────────

  test("register keystores for Alice and Bob", async () => {
    await registerKeystore(alice);
    await registerKeystore(bob);
  });

  test("Alice deposit 0.005 ETH", async () => {
    const result = await deposit(alice, DEPOSIT_AMOUNT, ctx);
    depositLabel = result.label;
    expect(result.commitment).toBeDefined();
  });

  test("activate Alice deposit in ASP", async () => {
    await activateDeposit(depositLabel, [alice, bob], ctx);
  });

  // ─── Transfer 1: Alice → Bob ────────────────────────────────────────────

  test("Alice transfer 0.002 ETH to Bob", async () => {
    transfer1Result = await transfer(alice, bob, TRANSFER_1_AMOUNT, ctx);
    expect(transfer1Result.recipientCommitment).toBeDefined();

    // Refresh sessions for next operations
    await activateDeposit([], [alice, bob], ctx);
  });

  // ─── Discovery: Bob finds his note via catch-all ────────────────────────

  test("Bob discover received note via catch-all scan", async () => {
    // Build simulated encrypted events from the transfer result
    const events = buildEventsFromTransferResult({
      crypto: alice.cryptoService,
      recipientViewingPubKey: bob.viewingPublicKey as PublicKey,
      transferResult: transfer1Result,
      blockNumber: "0x1" as Hex,
      txHash:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hash,
      asset: ctx.config.tokenId as Address,
    });

    // Bob discovers his note
    const discoveredNotes = await discoverWithSimulatedEvents(bob, events);

    expect(discoveredNotes).toHaveLength(1);

    const note = discoveredNotes[0];
    expect(note.commitment).toBeDefined();
    expect(note.value).toBe(transfer1Result.recipientNoteData.value);
    expect(note.tokenId).toBe(transfer1Result.recipientNoteData.tokenId);
    expect(note.noteSecret).toBe(transfer1Result.recipientNoteData.noteSecret);
    expect(note.status).toBe("INACTIVE");
    expect(note.isOwned).toBe(true);
    expect(note.ownerAddress).toBe(bob.address);
    expect(note.spentAtBlock).toBeNull();

    console.log(
      `  [bob] Discovered note: ${note.commitment.slice(0, 10)}... value=${note.value}`,
    );
  });

  // ─── Transfer 2: Alice → Bob again ──────────────────────────────────────

  test("Alice transfer 0.001 ETH to Bob", async () => {
    transfer2Result = await transfer(alice, bob, TRANSFER_2_AMOUNT, ctx);
    expect(transfer2Result.recipientCommitment).toBeDefined();
  });

  // ─── Discovery: Bob scans multiple events at once ───────────────────────

  test("Bob discover second note from batch scan", async () => {
    // The second transfer shares the same deposit lineage label as the first.
    // Since catch-all discovery doesn't know parent relationships, we simulate
    // this note with a unique label to avoid duplicate-root conflicts in NoteManager.
    // In production, a reconciliation step would link same-label notes to their lineage.
    const transfer2Payload: NotePayload = {
      noteSecret: transfer2Result.recipientNoteData.noteSecret as Secret,
      value: transfer2Result.recipientNoteData.value,
      tokenId: transfer2Result.recipientNoteData.tokenId as Address,
      label: ("0x" + "ab".repeat(32)) as Hash, // unique label for independent discovery
    };

    const events = [
      buildSimulatedNoteEvent({
        crypto: alice.cryptoService,
        recipientViewingPubKey: bob.viewingPublicKey as PublicKey,
        notePayload: transfer2Payload,
        blockNumber: "0x2" as Hex,
        txHash:
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hash,
        asset: ctx.config.tokenId as Address,
      }),
    ];

    // Bob's session already has the first note from previous discovery.
    // Export, create fresh session, import, then discover the second batch.
    const savedExport = bob.poolSession.exportAccount();
    await createTestSession(bob, ctx);
    bob.poolSession.importAccount(savedExport);

    const discoveredNotes = await discoverWithSimulatedEvents(bob, events);

    expect(discoveredNotes).toHaveLength(1);
    expect(discoveredNotes[0].commitment).toBeDefined();
    expect(discoveredNotes[0].value).toBe(
      transfer2Result.recipientNoteData.value,
    );

    console.log(
      `  [bob] Discovered second note: ${discoveredNotes[0].commitment.slice(0, 10)}...`,
    );
  });

  // ─── Discovery: Mixed events — each user finds only their own ───────────

  test("mixed events — Bob only discover his notes, not Alice change notes", async () => {
    // Build events containing:
    // 1. A note encrypted for Bob (from transfer 1)
    // 2. A note encrypted for Alice (simulated change note)
    const bobEvent = buildSimulatedNoteEvent({
      crypto: alice.cryptoService,
      recipientViewingPubKey: bob.viewingPublicKey as PublicKey,
      notePayload: {
        noteSecret: ("0x" + "aa".repeat(32)) as Secret,
        value: "0x100" as Hex,
        tokenId: ctx.config.tokenId as Address,
        label: ("0x" + "bb".repeat(32)) as Hash,
      },
      blockNumber: "0x10" as Hex,
      txHash: ("0x" + "dd".repeat(32)) as Hash,
      asset: ctx.config.tokenId as Address,
    });

    const aliceEvent = buildSimulatedNoteEvent({
      crypto: alice.cryptoService,
      recipientViewingPubKey: alice.viewingPublicKey as PublicKey,
      notePayload: {
        noteSecret: ("0x" + "ee".repeat(32)) as Secret,
        value: "0x200" as Hex,
        tokenId: ctx.config.tokenId as Address,
        label: ("0x" + "ff".repeat(32)) as Hash,
      },
      blockNumber: "0x10" as Hex,
      txHash: ("0x" + "22".repeat(32)) as Hash,
      asset: ctx.config.tokenId as Address,
    });

    // Recreate Bob session to avoid duplicates from earlier discovery
    const savedExport = bob.poolSession.exportAccount();
    await createTestSession(bob, ctx);
    bob.poolSession.importAccount(savedExport);

    // Bob scans both events — should only find the one encrypted for him
    const bobDiscovered = await discoverWithSimulatedEvents(bob, [
      bobEvent,
      aliceEvent,
    ]);

    expect(bobDiscovered).toHaveLength(1);
    expect(bobDiscovered[0].commitment).toBeDefined();
    expect(bobDiscovered[0].value).toBe("0x100");

    console.log(
      `  [bob] Discovered ${bobDiscovered.length} note(s) from mixed events (expected 1)`,
    );
  });

  // ─── Discovery: Sender discovers own change note ────────────────────────

  test("Alice discover own change note via catch-all", async () => {
    // Alice encrypts her change note data to her own viewing key.
    // We use a unique label to avoid duplicate-root conflicts — in production,
    // a reconciliation step would link this back to the deposit lineage.
    const changeNotePayload: NotePayload = {
      noteSecret: ("0x" + "33".repeat(32)) as Secret,
      value: `0x${transfer1Result.changeValue.toString(16)}` as Hex,
      tokenId: ctx.config.tokenId as Address,
      label: ("0x" + "cd".repeat(32)) as Hash,
    };

    const event = buildSimulatedNoteEvent({
      crypto: alice.cryptoService,
      recipientViewingPubKey: alice.viewingPublicKey as PublicKey,
      notePayload: changeNotePayload,
      blockNumber: "0x20" as Hex,
      txHash: ("0x" + "55".repeat(32)) as Hash,
      asset: ctx.config.tokenId as Address,
    });

    // Create fresh Alice session for clean discovery
    const savedExport = alice.poolSession.exportAccount();
    await createTestSession(alice, ctx);
    alice.poolSession.importAccount(savedExport);

    const discovered = await discoverWithSimulatedEvents(alice, [event]);

    expect(discovered).toHaveLength(1);
    expect(discovered[0].value).toBe(changeNotePayload.value);
    expect(discovered[0].label).toBe(changeNotePayload.label);
    expect(discovered[0].ownerAddress).toBe(alice.address);

    console.log(
      `  [alice] Discovered own change note: ${discovered[0].commitment.slice(0, 10)}... ` +
        `value=${discovered[0].value}`,
    );
  });
});
