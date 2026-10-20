import { parseEther } from "viem";

import type { Hex } from "@privacy-pools-v2/evm-sdk";

import { depositForEVMPublish } from "../../src/deposit/depositForEVMPublish.js";
import { config, requireAliceConfig } from "../../src/util/config.js";
import { createAlicePoolSession } from "../../src/util/createAlicePoolSession.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import {
    assertCommitmentOnChain,
    assertKeystoreRegistered,
    assertRecipientCanDiscoverNote,
} from "../util/assertions.js";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? config.depositAmount;
    const aliceCfg = requireAliceConfig();
    const bob = await createBobPoolSession({ withWalletClient: true });
    const alice = await createAlicePoolSession();
    const value = `0x${parseEther(amountArg).toString(16)}` as Hex;
    console.log(`Bob: ${bob.address}  Alice (env): ${aliceCfg.address}  amount=${amountArg} ETH`);

    // Pre: Alice (env) must be registered for the SDK to fetch her viewing key.
    await assertKeystoreRegistered(alice.poolSession, "Alice");

    const { prepared, receipt } = await depositForEVMPublish(bob.poolSession, {
        tokenId: config.tokenId,
        value,
        recipientAddress: aliceCfg.address,
    });
    if (!receipt.status) throw new Error("Deposit reverted");

    await assertCommitmentOnChain(bob.poolVaultInteractor, prepared.pendingNote.commitment);
    await assertRecipientCanDiscoverNote(
        alice.poolSession,
        prepared.pendingNote.commitment,
        "Alice",
    );
    console.log(`✓ depositForEVMPublish ok — ${prepared.pendingNote.commitment}`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
