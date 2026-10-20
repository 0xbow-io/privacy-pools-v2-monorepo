import { parseEther } from "viem";

import type { Hex } from "@privacy-pools-v2/evm-sdk";

import { transferWithPublicViewingKey } from "../../src/transfer/transferWithPublicViewingKey.js";
import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { createRandomPoolSession } from "../../src/util/createRandomPoolSession.js";
import { loadActiveNote } from "../../src/util/loadActiveNote.js";
import {
    assertCommitmentOnChain,
    assertRecipientCanDiscoverNote,
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

    const { prepared, receipt } = await transferWithPublicViewingKey(
        bob.poolSession,
        {
            inputCommitment: inputNote.commitment,
            recipientAddress: alice.address,
            recipientViewingPublicKey: alice.keys.viewingPublicKey,
            amount,
            tokenId: config.tokenId,
        },
        { hashService: bob.hashService, cryptoService: bob.cryptoService },
    );
    if (!receipt.status) throw new Error("Transfer reverted");

    const recipientCommitment = prepared.executeOptions.recipientPendingNotes[0]?.commitment;
    if (!recipientCommitment) throw new Error("No recipient pending note returned");

    await assertCommitmentOnChain(bob.poolVaultInteractor, recipientCommitment);
    await assertRecipientCanDiscoverNote(alice.poolSession, recipientCommitment, "Alice");
    console.log(`✓ transferWithPublicViewingKey ok — ${recipientCommitment}`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
