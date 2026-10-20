import { bytesToHex, hexToBytes, randomBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { Hex } from "@privacy-pools-v2/evm-sdk";

import type { BoundWalletClient, TestActor, TestContext } from "./types.js";
import { persistActor } from "./recovery.js";

/**
 * Creates a fresh ephemeral test actor with a random wallet and privacy keys.
 * Registers the actor in `ctx.actors` for cleanup tracking.
 */
export function createTestActor(name: string, ctx: TestContext): TestActor {
    // Random EOA wallet
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const walletClient = createWalletClient({
        account,
        chain: sepolia,
        transport: http(ctx.config.rpcUrl),
    }) as BoundWalletClient;

    // Privacy keys (same pattern as generate-keys.ts)
    const privateNullifyingKey = ("0x" + bytesToHex(randomBytes(32))) as Hex;
    const privateRevocableKey = ("0x" + bytesToHex(randomBytes(32))) as Hex;
    const viewingPrivateKey = ("0x" + bytesToHex(randomBytes(32))) as Hex;

    const viewingPublicKeyBytes = x25519.getPublicKey(hexToBytes(viewingPrivateKey.slice(2)));
    const viewingPublicKey = ("0x" + bytesToHex(viewingPublicKeyBytes)) as Hex;

    const actor: TestActor = {
        name,
        privateKey: privateKey as Hex,
        address: account.address as Hex,
        walletClient,
        privateNullifyingKey,
        privateRevocableKey,
        viewingPrivateKey,
        viewingPublicKey,
        // Placeholders — set by createTestSession
        poolSession: undefined!,
        rpcInteractor: undefined!,
        hashService: undefined!,
        cryptoService: undefined!,
        poolVaultInteractor: undefined!,
    };

    ctx.actors.push(actor);
    persistActor(name, privateKey as Hex, account.address as Hex);
    console.log(`  [${name}] Created — address: ${account.address}`);

    return actor;
}
