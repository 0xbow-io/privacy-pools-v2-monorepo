import { registerKeystore } from "../../src/keystore/registerKeystore.js";
import { createAlicePoolSession } from "../../src/util/createAlicePoolSession.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const onlyBob = args.includes("--bob");
    const onlyAlice = args.includes("--alice");
    const both = !onlyBob && !onlyAlice;

    if (both || onlyBob) {
        const bob = await createBobPoolSession({ withWalletClient: true });
        const receipts = await registerKeystore(bob.poolSession);
        for (const r of receipts) {
            if (!r.status) throw new Error(`Bob registration tx reverted: ${r.txHash}`);
        }
        if (!(await bob.poolSession.isKeystoreRegistered())) {
            throw new Error("Post-condition: Bob still reports unregistered after txs confirmed.");
        }
        console.log(`✓ Bob registered (${receipts.length} tx)`);
    }

    if (both || onlyAlice) {
        const alice = await createAlicePoolSession({ withWalletClient: true });
        const receipts = await registerKeystore(alice.poolSession);
        for (const r of receipts) {
            if (!r.status) throw new Error(`Alice registration tx reverted: ${r.txHash}`);
        }
        if (!(await alice.poolSession.isKeystoreRegistered())) {
            throw new Error("Post-condition: Alice still reports unregistered after txs confirmed.");
        }
        console.log(`✓ Alice registered (${receipts.length} tx)`);
    }

    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
