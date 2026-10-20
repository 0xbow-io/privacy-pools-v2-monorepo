import { parseEther } from "viem";

import type { Hash, Hex } from "@privacy-pools-v2/evm-sdk";
import { NoteStatus } from "@privacy-pools-v2/evm-sdk";

import { prepareAndRegisterDeposit } from "../../src/externalBroadcast/addNote.js";
import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { createSepoliaWalletClient } from "../../src/util/createWalletClient.js";
import { assertCommitmentOnChain } from "../util/assertions.js";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? config.depositAmount;
    // Build the SDK session WITHOUT a wallet interactor — we'll broadcast ourselves.
    const bob = await createBobPoolSession({ withWalletClient: false });
    const wallet = createSepoliaWalletClient(config.bob.privateKey);
    const value = `0x${parseEther(amountArg).toString(16)}` as Hex;
    console.log(`Bob: ${bob.address}  amount=${amountArg} ETH (external broadcast)`);

    const { prepared, txHash } = await prepareAndRegisterDeposit(
        bob.poolSession,
        { tokenId: config.tokenId, value },
        async (p) => {
            const hash = await wallet.sendTransaction({
                to: p.to,
                data: p.callData,
                value: BigInt(p.msgValue),
            });
            await bob.rpcInteractor.waitForTransactionReceipt(hash as Hash);
            return hash as Hash;
        },
    );

    await assertCommitmentOnChain(bob.poolVaultInteractor, prepared.pendingNote.commitment);

    const account = await bob.poolSession.exportAccount();
    const persisted = account.notes.find(
        (n) => n.commitment === prepared.pendingNote.commitment,
    );
    if (!persisted) {
        throw new Error(
            "Post-condition violated: externally-broadcast note is not in NoteManager. " +
                "→ session.addNotes() should persist the pending note on success.",
        );
    }
    if (persisted.status !== NoteStatus.PENDING && persisted.status !== NoteStatus.ACTIVE) {
        throw new Error(
            `Post-condition violated: persisted note status is ${persisted.status}, expected PENDING or ACTIVE.`,
        );
    }
    console.log(
        `✓ external-broadcast addNote ok — commitment ${persisted.commitment} status=${persisted.status} tx=${txHash}`,
    );
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
