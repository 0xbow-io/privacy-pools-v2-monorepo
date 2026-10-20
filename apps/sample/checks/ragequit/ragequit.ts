import type { Hex } from "@privacy-pools-v2/evm-sdk";

import { ragequit } from "../../src/ragequit/ragequit.js";
import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { createSepoliaWalletClient } from "../../src/util/createWalletClient.js";
import { loadActiveNote } from "../../src/util/loadActiveNote.js";
import { assertNullifierSpent } from "../util/assertions.js";

async function main(): Promise<void> {
    const bob = await createBobPoolSession();
    const walletClient = createSepoliaWalletClient(config.bob.privateKey);

    const inputNote = await loadActiveNote({
        poolSession: bob.poolSession,
        tokenId: config.tokenId,
        minValue: "0x1" as Hex,
        ownerLabel: "Bob",
    });

    const { prepared, receipt } = await ragequit(
        bob.poolSession,
        walletClient,
        bob.rpcInteractor,
        inputNote.commitment,
    );
    if (!receipt.status) throw new Error("Ragequit reverted");

    await assertNullifierSpent(bob.poolVaultInteractor, prepared.nullifierHash);
    console.log(`✓ ragequit ok — nullifier ${prepared.nullifierHash}`);
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
