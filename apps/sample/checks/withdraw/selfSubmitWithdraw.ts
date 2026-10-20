import { parseEther } from "viem";

import type { Hash, Hex } from "@privacy-pools-v2/evm-sdk";

import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { createSepoliaWalletClient } from "../../src/util/createWalletClient.js";
import { loadActiveNote } from "../../src/util/loadActiveNote.js";
import { selfSubmitWithdraw } from "../../src/withdraw/selfSubmitWithdraw.js";
import { assertNullifierSpent } from "../util/assertions.js";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? config.depositAmount;
    const amount = `0x${parseEther(amountArg).toString(16)}` as Hex;

    const bob = await createBobPoolSession();
    const walletClient = createSepoliaWalletClient(config.bob.privateKey);

    const inputNote = await loadActiveNote({
        poolSession: bob.poolSession,
        tokenId: config.tokenId,
        minValue: amount,
        ownerLabel: "Bob",
    });

    const { receipt } = await selfSubmitWithdraw(
        bob.poolSession,
        walletClient,
        bob.rpcInteractor,
        {
            inputCommitment: inputNote.commitment,
            recipientAddress: bob.address,
            amount,
            tokenId: config.tokenId,
            // Reuse the same registered processor the SDK relayer uses — feeAmount=0
            // means no fee is paid, but the contract still requires a registered
            // processor for transact() to succeed.
            processorAddress: config.relayerProcessorAddress,
        },
    );
    if (!receipt.status) throw new Error("Self-submit withdraw reverted");

    const nullifierHash = bob.hashService.hash([
        config.bob.privateNullifyingKey,
        inputNote.commitment,
    ]) as Hash;
    await assertNullifierSpent(bob.poolVaultInteractor, nullifierHash);
    console.log(`✓ selfSubmitWithdraw ok — nullifier ${nullifierHash}`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
