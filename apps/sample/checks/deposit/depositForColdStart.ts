import { parseEther } from "viem";

import type { Hex } from "@privacy-pools-v2/evm-sdk";

import { depositForColdStart } from "../../src/deposit/depositForColdStart.js";
import { importColdStartNote } from "../../src/noteDiscovery/importColdStartNote.js";
import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { createRandomPoolSession } from "../../src/util/createRandomPoolSession.js";
import {
    assertCommitmentOnChain,
    assertKeystoreNotRegistered,
    assertRecipientCannotDiscoverNote,
} from "../util/assertions.js";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? config.depositAmount;
    const bob = await createBobPoolSession({ withWalletClient: true });
    const alice = await createRandomPoolSession();
    const value = `0x${parseEther(amountArg).toString(16)}` as Hex;
    console.log(`Bob: ${bob.address}  Alice (random): ${alice.address}  amount=${amountArg} ETH`);

    // Pre: random Alice is by construction unregistered.
    await assertKeystoreNotRegistered(alice.poolSession, "Alice");

    const { prepared, receipt, noteSecret } = await depositForColdStart(
        bob.poolSession,
        { tokenId: config.tokenId, value, recipientAddress: alice.address },
        { hashService: bob.hashService, cryptoService: bob.cryptoService },
    );
    if (!receipt.status) throw new Error("Deposit reverted");

    // Post: commitment on-chain.
    await assertCommitmentOnChain(bob.poolVaultInteractor, prepared.pendingNote.commitment);

    // Post: Alice cannot auto-discover — defining property of the blind path.
    await assertRecipientCannotDiscoverNote(
        alice.poolSession,
        prepared.pendingNote.commitment,
        "Alice",
    );

    // Post: out-of-band recovery works — Alice imports manually.
    const createdAtBlock = await bob.poolVaultInteractor.getCommitmentTimestamp(
        prepared.pendingNote.commitment,
    );
    await importColdStartNote(alice.poolSession, {
        commitment: prepared.pendingNote.commitment,
        label: prepared.pendingNote.label,
        value: prepared.pendingNote.value,
        tokenId: prepared.pendingNote.tokenId,
        noteAddressHash: prepared.pendingNote.noteAddressHash,
        noteSecret,
        ownerAddress: alice.address,
        createdAtBlock,
        txHash: receipt.txHash,
    });
    const aliceState = await alice.poolSession.exportAccount();
    if (!aliceState.notes.find((n) => n.commitment === prepared.pendingNote.commitment)) {
        throw new Error(
            "Post-condition violated: imported note is missing from Alice's exportAccount().",
        );
    }
    console.log(`✓ depositForColdStart ok — Alice imported ${prepared.pendingNote.commitment}`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
