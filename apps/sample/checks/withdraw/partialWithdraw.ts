import { parseEther } from "viem";

import type { Hash, Hex } from "@privacy-pools-v2/evm-sdk";
import { NoteStatus } from "@privacy-pools-v2/evm-sdk";

import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { loadActiveNote } from "../../src/util/loadActiveNote.js";
import { partialWithdraw } from "../../src/withdraw/partialWithdraw.js";
import { assertNullifierSpent } from "../util/assertions.js";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? "0.001";
    const amount = `0x${parseEther(amountArg).toString(16)}` as Hex;

    const bob = await createBobPoolSession();

    // Need value > amount so the SDK produces a change note.
    const inputNote = await loadActiveNote({
        poolSession: bob.poolSession,
        tokenId: config.tokenId,
        minValue: `0x${(BigInt(amount) + 1n).toString(16)}` as Hex,
        ownerLabel: "Bob (need value > amount for change note)",
    });

    // Snapshot the local note set BEFORE the withdraw so we can detect the
    // new change note by diff. We can't compare against
    // `prepared.changePendingNotes[0]` because `relayWithdraw` re-runs
    // `prepareTransact` with the relayer-quoted feeAmount/amountOut, which
    // changes the change-note value (and therefore the commitment) vs. what
    // `prepareWithdraw` returned. Only the relay-side change commitment is
    // ever persisted in the NoteManager.
    const before = new Set(
        (await bob.poolSession.exportAccount()).notes.map((n) => n.commitment.toLowerCase()),
    );

    const { receipt } = await partialWithdraw(bob.poolSession, {
        inputCommitment: inputNote.commitment,
        recipientAddress: bob.address,
        amount,
        tokenId: config.tokenId,
    });
    if (!receipt.status) throw new Error("Withdraw reverted");

    const nullifierHash = bob.hashService.hash([
        config.bob.privateNullifyingKey,
        inputNote.commitment,
    ]) as Hash;
    await assertNullifierSpent(bob.poolVaultInteractor, nullifierHash);

    // `relayWithdraw` may skip local persistence if the post-tx commitment-timestamp
    // read returns null (RPC chain-tip lag); the SDK's documented contract is that
    // `discoverNotes()` recovers the change note on the next scan. So we follow up
    // with discoverNotes() before asserting.
    await bob.poolSession.discoverNotes();
    const after = (await bob.poolSession.exportAccount()).notes;
    const newNotes = after.filter((n) => !before.has(n.commitment.toLowerCase()));
    const changeNote = newNotes.find(
        (n) => n.status === NoteStatus.PENDING || n.status === NoteStatus.ACTIVE,
    );
    if (!changeNote) {
        throw new Error(
            "Post-condition violated: no PENDING/ACTIVE change note after relayWithdraw + discoverNotes. " +
                "→ Either the change-note was never minted on-chain or the discovery scan missed it.",
        );
    }
    console.log(`✓ partialWithdraw ok — change ${changeNote.commitment} status=${changeNote.status}`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
