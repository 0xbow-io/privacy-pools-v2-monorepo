import type { Hex } from "@privacy-pools-v2/evm-sdk";

import { discoverRevocableKeyIndex } from "../../src/keystore/discoverRevocableKeyIndex.js";
import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { createSepoliaWalletClient } from "../../src/util/createWalletClient.js";

async function main(): Promise<void> {
    const bob = await createBobPoolSession({ withWalletClient: true });
    const walletClient = createSepoliaWalletClient(config.bob.privateKey);

    if (!(await bob.poolSession.isKeystoreRegistered())) {
        throw new Error(
            "Pre-condition: Bob keystore must be registered before discovery. Run register-keystore first.",
        );
    }

    console.log("  scanning on-chain authDigest against HKDF candidates...");

    let discoveredIndex: Hex;
    try {
        discoveredIndex = await discoverRevocableKeyIndex(bob.poolSession, walletClient);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/No matching revocable-key index/.test(msg)) {
            throw new Error(
                "Discovery exhausted gapLimit. The on-chain authDigest does not match any HKDF-derived " +
                    "candidate from this signature. The sample registers with RANDOM `protocolKeys` from " +
                    ".env, so discovery only finds a match after at least one rotation has switched the " +
                    "chain to HKDF-derived keys. Run `check:rotateRevocableKey` first, then retry.",
            );
        }
        throw error;
    }

    console.log(`  discovered index: ${discoveredIndex}`);
    console.log(`✓ Bob revocable-key index recovered from chain`);

    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
