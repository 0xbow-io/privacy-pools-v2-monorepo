import { parseEther } from "viem";

import type { Hash, Hex } from "@privacy-pools-v2/evm-sdk";

import { importColdStartNote } from "../../src/noteDiscovery/importColdStartNote.js";
import { coldTransfer } from "../../src/transfer/coldTransfer.js";
import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { createRandomPoolSession } from "../../src/util/createRandomPoolSession.js";
import { loadActiveNote } from "../../src/util/loadActiveNote.js";
import {
    assertCommitmentOnChain,
    assertKeystoreNotRegistered,
    assertRecipientCannotDiscoverNote,
} from "../util/assertions.js";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? config.depositAmount;
    const amount = `0x${parseEther(amountArg).toString(16)}` as Hex;

    const bob = await createBobPoolSession();
    const alice = await createRandomPoolSession();

    // Pre: random Alice is unregistered — that's the precondition for cold-start.
    await assertKeystoreNotRegistered(alice.poolSession, "Alice");

    const inputNote = await loadActiveNote({
        poolSession: bob.poolSession,
        tokenId: config.tokenId,
        minValue: amount,
        ownerLabel: "Bob",
    });

    const { prepared, receipt, noteSecretsMap } = await coldTransfer(bob.poolSession, {
        inputCommitment: inputNote.commitment,
        recipientEvmAddress: alice.address,
        amount,
        tokenId: config.tokenId,
    });
    if (!receipt.status) throw new Error("coldTransfer reverted");

    const recipientPending = prepared.executeOptions.recipientPendingNotes[0];
    if (!recipientPending) throw new Error("No recipient pending note returned");

    // Post: commitment on-chain.
    await assertCommitmentOnChain(bob.poolVaultInteractor, recipientPending.commitment);

    // Post: no announcement — Alice cannot auto-discover.
    await assertRecipientCannotDiscoverNote(
        alice.poolSession,
        recipientPending.commitment,
        "Alice",
    );

    // Out-of-band: deliver noteSecret + import. The SDK keyed `noteSecretsMap`
    // by noteAddressHash, so we look up by the recipientPending.noteAddressHash.
    const noteSecret = noteSecretsMap.get(recipientPending.noteAddressHash);
    if (!noteSecret) {
        throw new Error(
            `Post-condition violated: noteSecret missing for noteAddressHash ${recipientPending.noteAddressHash}.`,
        );
    }
    const createdAtBlock = await bob.poolVaultInteractor.getCommitmentTimestamp(
        recipientPending.commitment,
    );
    await importColdStartNote(alice.poolSession, {
        commitment: recipientPending.commitment,
        label: recipientPending.label,
        value: recipientPending.value,
        tokenId: recipientPending.tokenId,
        noteAddressHash: recipientPending.noteAddressHash as Hash,
        noteSecret,
        ownerAddress: alice.address,
        createdAtBlock,
        txHash: receipt.txHash,
    });
    const aliceState = await alice.poolSession.exportAccount();
    if (!aliceState.notes.find((n) => n.commitment === recipientPending.commitment)) {
        throw new Error("Imported note missing from Alice's exportAccount()");
    }
    console.log(`✓ coldTransfer ok — Alice imported ${recipientPending.commitment}`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
