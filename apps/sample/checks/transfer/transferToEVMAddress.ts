import { parseEther } from "viem";

import type { Hex } from "@privacy-pools-v2/evm-sdk";

import { transferToEVMAddress } from "../../src/transfer/transferToEVMAddress.js";
import { config, requireAliceConfig } from "../../src/util/config.js";
import { createAlicePoolSession } from "../../src/util/createAlicePoolSession.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { loadActiveNote } from "../../src/util/loadActiveNote.js";
import {
    assertCommitmentOnChain,
    assertKeystoreRegistered,
    assertRecipientCanDiscoverNote,
} from "../util/assertions.js";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? config.depositAmount;
    const amount = `0x${parseEther(amountArg).toString(16)}` as Hex;

    const aliceCfg = requireAliceConfig();
    const bob = await createBobPoolSession();
    const alice = await createAlicePoolSession();

    await assertKeystoreRegistered(alice.poolSession, "Alice");

    const inputNote = await loadActiveNote({
        poolSession: bob.poolSession,
        tokenId: config.tokenId,
        minValue: amount,
        ownerLabel: "Bob",
    });

    const { prepared, receipt } = await transferToEVMAddress(bob.poolSession, {
        inputCommitment: inputNote.commitment,
        recipientAddress: aliceCfg.address,
        amount,
        tokenId: config.tokenId,
    });
    if (!receipt.status) throw new Error("Transfer reverted");

    const recipientCommitment = prepared.executeOptions.recipientPendingNotes[0]?.commitment;
    if (!recipientCommitment) throw new Error("No recipient pending note returned");

    await assertCommitmentOnChain(bob.poolVaultInteractor, recipientCommitment);
    await assertRecipientCanDiscoverNote(alice.poolSession, recipientCommitment, "Alice");
    console.log(`✓ transferToEVMAddress ok — ${recipientCommitment}`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
