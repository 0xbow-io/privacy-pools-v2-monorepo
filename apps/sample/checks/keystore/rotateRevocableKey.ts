import { rotateRevocableKey } from "../../src/keystore/rotateRevocableKey.js";
import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { createSepoliaWalletClient } from "../../src/util/createWalletClient.js";

async function main(): Promise<void> {
    const bob = await createBobPoolSession({ withWalletClient: true });
    const walletClient = createSepoliaWalletClient(config.bob.privateKey);

    if (!(await bob.poolSession.isKeystoreRegistered())) {
        throw new Error(
            "Pre-condition: Bob keystore must be registered before rotation. Run register-keystore first.",
        );
    }

    const indexBefore = bob.poolSession.getRevocableKeyIndex();
    console.log(`  index before: ${indexBefore}`);

    let outcome;
    try {
        outcome = await rotateRevocableKey(bob.poolSession, walletClient);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/Current keystore leaf .* not found/.test(msg)) {
            throw new Error(
                "Rotation aborted: on-chain authDigest does not match local KeystoreManager. " +
                    "This sample is one-shot — re-generating the random `protocolKeys` in `.env` puts " +
                    "local state out of sync with chain. Regenerate keys + re-register to retry.",
            );
        }
        throw error;
    }

    if (!outcome.receipt.status) {
        throw new Error(`Rotation tx reverted: ${outcome.receipt.txHash}`);
    }

    const indexAfter = bob.poolSession.getRevocableKeyIndex();
    if (BigInt(indexAfter) !== BigInt(indexBefore) + 1n) {
        throw new Error(
            `Post-condition: rotation index did not advance by 1 (before=${indexBefore}, after=${indexAfter}).`,
        );
    }

    if (BigInt(outcome.newRevocableKeyIndex) !== BigInt(indexAfter)) {
        throw new Error(
            `Post-condition: outcome.newRevocableKeyIndex (${outcome.newRevocableKeyIndex}) does not match getRevocableKeyIndex() (${indexAfter}).`,
        );
    }

    if (outcome.oldAuthorizerDigest === outcome.newAuthorizerDigest) {
        throw new Error("Post-condition: oldAuthorizerDigest equals newAuthorizerDigest.");
    }

    // Integrator-side persistence happens here in a real app: write
    // outcome.newRevocableKeyIndex to durable storage together with the
    // receipt. Skipping the write strands the next session on the stale
    // index and every subsequent proof fails until manual recovery.
    console.log(`  index after:  ${indexAfter}`);
    console.log(`  outcome idx:  ${outcome.newRevocableKeyIndex}`);
    console.log(`  old digest:   ${outcome.oldAuthorizerDigest}`);
    console.log(`  new digest:   ${outcome.newAuthorizerDigest}`);
    console.log(`  tx hash:      ${outcome.receipt.txHash}`);
    console.log(`✓ Bob rotated revocable key (${indexBefore} → ${indexAfter})`);

    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
