import { parseEther } from "viem";

import type { Hash, Hex } from "@privacy-pools-v2/evm-sdk";

import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { loadActiveNote } from "../../src/util/loadActiveNote.js";
import { withdraw } from "../../src/withdraw/withdraw.js";
import { assertNullifierSpent } from "../util/assertions.js";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? config.depositAmount;
    const amount = `0x${parseEther(amountArg).toString(16)}` as Hex;

    const bob = await createBobPoolSession();

    const inputNote = await loadActiveNote({
        poolSession: bob.poolSession,
        tokenId: config.tokenId,
        minValue: amount,
        ownerLabel: "Bob",
    });

    const { receipt } = await withdraw(bob.poolSession, {
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
    console.log(`✓ withdraw ok — nullifier ${nullifierHash}`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
