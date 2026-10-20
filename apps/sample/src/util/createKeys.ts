import { bytesToHex, hexToBytes, randomBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { Hex } from "@privacy-pools-v2/evm-sdk";

export type ProtocolKeyMaterial = {
    privateNullifyingKey: Hex;
    privateRevocableKey: Hex;
    viewingPrivateKey: Hex;
    viewingPublicKey: Hex;
};

export type AccountKeyMaterial = ProtocolKeyMaterial & {
    walletPrivateKey: Hex;
    address: Hex;
};

export function createProtocolKeys(): ProtocolKeyMaterial {
    const privateNullifyingKey = ("0x" + bytesToHex(randomBytes(32))) as Hex;
    const privateRevocableKey = ("0x" + bytesToHex(randomBytes(32))) as Hex;
    const viewingPrivateKey = ("0x" + bytesToHex(randomBytes(32))) as Hex;
    const viewingPublicKey = ("0x" +
        bytesToHex(x25519.getPublicKey(hexToBytes(viewingPrivateKey.slice(2))))) as Hex;
    return {
        privateNullifyingKey,
        privateRevocableKey,
        viewingPrivateKey,
        viewingPublicKey,
    };
}

export function createAccountKeys(): AccountKeyMaterial {
    const walletPrivateKey = generatePrivateKey() as Hex;
    const address = privateKeyToAccount(walletPrivateKey).address as Hex;
    return {
        walletPrivateKey,
        address,
        ...createProtocolKeys(),
    };
}

function isCli(): boolean {
    if (process.argv[1] === undefined) return false;
    const filename = new URL(import.meta.url).pathname;
    return process.argv[1] === filename;
}

if (isCli()) {
    console.log("=== Privacy Pools V2 - Key Generation ===\n");

    const accountKeys = createAccountKeys();
    const aspPrivateKey = ("0x" + bytesToHex(randomBytes(32))) as Hex;
    const aspPublicKey = ("0x" +
        bytesToHex(x25519.getPublicKey(hexToBytes(aspPrivateKey.slice(2))))) as Hex;

    console.log("Add these to your .env file:\n");
    console.log("# Wallet");
    console.log(`PRIVATE_KEY=${accountKeys.walletPrivateKey}`);
    console.log(`# Address: ${accountKeys.address}`);
    console.log("");
    console.log("# Account keys");
    console.log(`PRIVATE_NULLIFYING_KEY=${accountKeys.privateNullifyingKey}`);
    console.log(`PRIVATE_REVOCABLE_KEY=${accountKeys.privateRevocableKey}`);
    console.log(`VIEWING_PRIVATE_KEY=${accountKeys.viewingPrivateKey}`);
    console.log(`VIEWING_PUBLIC_KEY=${accountKeys.viewingPublicKey}`);
    console.log("");
    console.log("# ASP keys");
    console.log(`ASP_PRIVATE_KEY=${aspPrivateKey}`);
    console.log(`ASP_PUBLIC_KEY=${aspPublicKey}`);

    console.log("\n  Save these keys securely. They cannot be recovered if lost.");
    console.log("  Losing them means losing access to your deposited funds.");
}
