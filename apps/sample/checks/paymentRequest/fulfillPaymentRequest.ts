import { parseEther } from "viem";

import type { Hex } from "@privacy-pools-v2/evm-sdk";

import { fulfillPaymentRequest } from "../../src/paymentRequest/fulfillPaymentRequest.js";
import { generatePaymentRequest } from "../../src/paymentRequest/generatePaymentRequest.js";
import { config } from "../../src/util/config.js";
import { createAlicePoolSession } from "../../src/util/createAlicePoolSession.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { loadActiveNote } from "../../src/util/loadActiveNote.js";
import {
    assertCommitmentOnChain,
    assertHexEq,
    assertRecipientCanDiscoverNote,
} from "../util/assertions.js";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? config.depositAmount;
    const amount = `0x${parseEther(amountArg).toString(16)}` as Hex;

    const bob = await createBobPoolSession();
    const alice = await createAlicePoolSession();

    // Alice generates the request.
    const paymentRequest = await generatePaymentRequest(alice.poolSession, {
        amount,
        tokenId: config.tokenId,
    });

    // Bob fulfills it.
    const inputNote = await loadActiveNote({
        poolSession: bob.poolSession,
        tokenId: config.tokenId,
        minValue: amount,
        ownerLabel: "Bob",
    });
    const { prepared, receipt } = await fulfillPaymentRequest(
        bob.poolSession,
        paymentRequest,
        [inputNote.commitment],
    );
    if (!receipt.status) throw new Error("Fulfillment reverted");

    const recipientCommitment = prepared.executeOptions.recipientPendingNotes[0]?.commitment;
    if (!recipientCommitment) throw new Error("No recipient pending note returned");

    await assertCommitmentOnChain(bob.poolVaultInteractor, recipientCommitment);
    await assertRecipientCanDiscoverNote(alice.poolSession, recipientCommitment, "Alice");

    // Tag carried by the relayed transfer must equal the request tag, so
    // Alice's paymentRequest record gets flipped to FULFILLED on discovery.
    if (prepared.relayOptions[0].recipient.hint) {
        assertHexEq(
            prepared.relayOptions[0].recipient.hint,
            paymentRequest.tag,
            "relay hint vs paymentRequest.tag",
        );
    }
    console.log(`✓ fulfillPaymentRequest ok — Alice discovered ${recipientCommitment}`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
