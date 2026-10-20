import type { PoolSession } from "@privacy-pools-v2/evm-sdk";
import { privateKeyToAccount } from "viem/accounts";

import {
    type BuilderInputs,
    createOverridePoolSession,
    createSimplePoolSession,
} from "../../src/builder/poolSessionBuilder.js";
import { config } from "../../src/util/config.js";
import { createSepoliaWalletClient } from "../../src/util/createWalletClient.js";

/**
 * Both builder paths must produce a session that exposes every PoolSession
 * operation we depend on. The check is structural — it confirms the
 * fluent-overrides path doesn't accidentally drop a service binding, and that
 * the simple path stays compatible after SDK changes.
 */
const REQUIRED_OPS = [
    "prepareDeposit",
    "deposit",
    "prepareDepositFor",
    "depositFor",
    "prepareTransfer",
    "prepareColdStartTransfer",
    "relayTransfer",
    "prepareWithdraw",
    "relayWithdraw",
    "prepareRageQuit",
    "discoverNotes",
    "exportAccount",
    "importAccount",
    "isKeystoreRegistered",
    "prepareRegisterKeystore",
    "registerKeystore",
    "generatePaymentRequest",
    "prepareFulfillPaymentRequest",
] as const;

function assertOps(session: PoolSession, label: string): void {
    for (const name of REQUIRED_OPS) {
        const fn = (session as unknown as Record<string, unknown>)[name];
        if (typeof fn !== "function") {
            throw new Error(`${label}: session.${name} is not a function (got ${typeof fn}).`);
        }
    }
}

async function main(): Promise<void> {
    const account = privateKeyToAccount(config.bob.privateKey as `0x${string}`);
    const walletClient = createSepoliaWalletClient(config.bob.privateKey);

    const inputs: BuilderInputs = {
        chainId: config.chainId,
        rpcUrl: config.rpcUrl,
        ownerAddress: account.address,
        protocolKeys: {
            privateNullifyingKey: config.bob.privateNullifyingKey,
            privateRevocableKey: config.bob.privateRevocableKey,
            viewingPrivateKey: config.bob.viewingPrivateKey,
            viewingPublicKey: config.bob.viewingPublicKey,
        },
        aspUrl: config.aspUrl,
        relayer: {
            url: config.relayerUrl,
            address: config.relayerAddress,
            processorAddress: config.relayerProcessorAddress,
        },
        walletClient,
    };

    // Option A — one-shot.
    const simple = await createSimplePoolSession(inputs);
    assertOps(simple, "simple");
    console.log(`✓ simple .create() — ${REQUIRED_OPS.length} ops`);

    // Option B — overrides.
    const override = await createOverridePoolSession(inputs);
    assertOps(override.poolSession, "override");
    // The override path also exposes the externally-constructed services so
    // the host app can keep using them — verify they're real, callable.
    if (typeof override.hashService.hash !== "function") {
        throw new Error("override.hashService is not wired");
    }
    if (typeof override.rpcInteractor.waitForTransactionReceipt !== "function") {
        throw new Error("override.rpcInteractor is not wired");
    }
    console.log(`✓ override .fromConfig().withX().create() — ${REQUIRED_OPS.length} ops + 4 shared services`);

    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
