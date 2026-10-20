import { privateKeyToAccount } from "viem/accounts";

import type { Hex, PersistentStorageConfig } from "@privacy-pools-v2/evm-sdk";

import { requireAliceConfig } from "./config.js";
import { createPoolSession, type CreatePoolSessionResult } from "./createPoolSession.js";
import { createSepoliaWalletClient } from "./createWalletClient.js";

export type CreateAlicePoolSessionOptions = {
    withWalletClient?: boolean;
    /** Forward to the SDK builder so NoteManager + PaymentRequestService persist. */
    persistentStorage?: PersistentStorageConfig;
};

export type CreateAlicePoolSessionResult = CreatePoolSessionResult & {
    address: Hex;
};

export async function createAlicePoolSession(
    options: CreateAlicePoolSessionOptions = {},
): Promise<CreateAlicePoolSessionResult> {
    const alice = requireAliceConfig();
    const account = privateKeyToAccount(alice.privateKey as `0x${string}`);
    const walletClient = options.withWalletClient
        ? createSepoliaWalletClient(alice.privateKey)
        : undefined;

    const session = await createPoolSession({
        ownerAddress: account.address as Hex,
        protocolKeys: {
            privateNullifyingKey: alice.privateNullifyingKey,
            privateRevocableKey: alice.privateRevocableKey,
            viewingPrivateKey: alice.viewingPrivateKey,
            viewingPublicKey: alice.viewingPublicKey,
        },
        walletClient,
        persistentStorage: options.persistentStorage,
    });

    return { ...session, address: account.address as Hex };
}
