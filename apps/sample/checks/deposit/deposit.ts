import { parseEther } from "viem";

import type { Hex } from "@privacy-pools-v2/evm-sdk";
import { NoteStatus } from "@privacy-pools-v2/evm-sdk";

import { depositPrepareExecute } from "../../src/deposit/deposit.js";
import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { assertCommitmentOnChain } from "../util/assertions.js";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? config.depositAmount;
    const bob = await createBobPoolSession({ withWalletClient: true });
    const value = `0x${parseEther(amountArg).toString(16)}` as Hex;
    console.log(`Bob: ${bob.address}  amount=${amountArg} ETH`);

    const { prepared, receipt } = await depositPrepareExecute(bob.poolSession, {
        tokenId: config.tokenId,
        value,
    });
    if (!receipt.status) throw new Error("Deposit reverted on-chain");

    // Post: commitment on-chain.
    await assertCommitmentOnChain(bob.poolVaultInteractor, prepared.pendingNote.commitment);

    // Post: executeDeposit persisted the note locally — without this step the
    //       note would be lost from the SDK's perspective.
    const account = await bob.poolSession.exportAccount();
    const persisted = account.notes.find(
        (n) => n.commitment === prepared.pendingNote.commitment,
    );
    if (!persisted) {
        throw new Error(
            "Post-condition violated: deposited note is not in NoteManager. " +
                "→ executeDeposit() should call NoteManager.addNote on success.",
        );
    }
    if (persisted.status !== NoteStatus.PENDING && persisted.status !== NoteStatus.ACTIVE) {
        throw new Error(
            `Post-condition violated: persisted note status is ${persisted.status}, expected PENDING or ACTIVE.`,
        );
    }
    console.log(`✓ deposit ok — commitment ${persisted.commitment} status=${persisted.status}`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
