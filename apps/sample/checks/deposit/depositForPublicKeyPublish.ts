import { parseEther } from "viem";

import type { Hex } from "@privacy-pools-v2/evm-sdk";

import { depositForPublicKeyPublish } from "../../src/deposit/depositForPublicKeyPublish.js";
import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { createRandomPoolSession } from "../../src/util/createRandomPoolSession.js";
import {
    assertCommitmentOnChain,
    assertRecipientCanDiscoverNote,
} from "../util/assertions.js";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? config.depositAmount;
    const bob = await createBobPoolSession({ withWalletClient: true });
    const alice = await createRandomPoolSession();
    const value = `0x${parseEther(amountArg).toString(16)}` as Hex;
    console.log(`Bob: ${bob.address}  Alice (random): ${alice.address}  amount=${amountArg} ETH`);

    const { prepared, receipt } = await depositForPublicKeyPublish(
        bob.poolSession,
        {
            tokenId: config.tokenId,
            value,
            recipientAddress: alice.address,
            recipientViewingPublicKey: alice.keys.viewingPublicKey,
        },
        { hashService: bob.hashService, cryptoService: bob.cryptoService },
    );
    if (!receipt.status) throw new Error("Deposit reverted");

    await assertCommitmentOnChain(bob.poolVaultInteractor, prepared.pendingNote.commitment);
    await assertRecipientCanDiscoverNote(
        alice.poolSession,
        prepared.pendingNote.commitment,
        "Alice",
    );
    console.log(`✓ depositForPublicKeyPublish ok — ${prepared.pendingNote.commitment}`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
