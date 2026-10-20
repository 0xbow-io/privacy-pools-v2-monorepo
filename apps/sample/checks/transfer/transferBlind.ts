import { parseEther } from "viem";

import type { Hex } from "@privacy-pools-v2/evm-sdk";

import { importColdStartNote } from "../../src/noteDiscovery/importColdStartNote.js";
import { transferBlind } from "../../src/transfer/transferBlind.js";
import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { createRandomPoolSession } from "../../src/util/createRandomPoolSession.js";
import { loadActiveNote } from "../../src/util/loadActiveNote.js";
import {
    assertCommitmentOnChain,
    assertRecipientCannotDiscoverNote,
} from "../util/assertions.js";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? config.depositAmount;
    const amount = `0x${parseEther(amountArg).toString(16)}` as Hex;

    const bob = await createBobPoolSession();
    const alice = await createRandomPoolSession();

    const inputNote = await loadActiveNote({
        poolSession: bob.poolSession,
        tokenId: config.tokenId,
        minValue: amount,
        ownerLabel: "Bob",
    });

    const { prepared, receipt, noteSecret } = await transferBlind(
        bob.poolSession,
        {
            inputCommitment: inputNote.commitment,
            recipientAddress: alice.address,
            amount,
            tokenId: config.tokenId,
        },
        { hashService: bob.hashService, cryptoService: bob.cryptoService },
    );
    if (!receipt.status) throw new Error("Transfer reverted");

    const recipientPending = prepared.executeOptions.recipientPendingNotes[0];
    if (!recipientPending) throw new Error("No recipient pending note returned");

    await assertCommitmentOnChain(bob.poolVaultInteractor, recipientPending.commitment);
    await assertRecipientCannotDiscoverNote(
        alice.poolSession,
        recipientPending.commitment,
        "Alice",
    );

    // Out-of-band recovery — same path as depositForColdStart.
    const createdAtBlock = await bob.poolVaultInteractor.getCommitmentTimestamp(
        recipientPending.commitment,
    );
    await importColdStartNote(alice.poolSession, {
        commitment: recipientPending.commitment,
        label: recipientPending.label,
        value: recipientPending.value,
        tokenId: recipientPending.tokenId,
        noteAddressHash: recipientPending.noteAddressHash,
        noteSecret,
        ownerAddress: alice.address,
        createdAtBlock,
        txHash: receipt.txHash,
    });
    const aliceState = await alice.poolSession.exportAccount();
    if (!aliceState.notes.find((n) => n.commitment === recipientPending.commitment)) {
        throw new Error("Imported note missing from Alice's exportAccount()");
    }
    console.log(`✓ transferBlind ok — Alice imported ${recipientPending.commitment}`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
