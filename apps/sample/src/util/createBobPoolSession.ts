import { privateKeyToAccount } from "viem/accounts";

import type { Hex, PersistentStorageConfig } from "@privacy-pools-v2/evm-sdk";

import { config } from "./config.js";
import { createPoolSession, type CreatePoolSessionResult } from "./createPoolSession.js";
import { createSepoliaWalletClient } from "./createWalletClient.js";

export type CreateBobPoolSessionOptions = {
    /** When true, attaches a viem wallet client so `poolSession.deposit/transfer/withdraw` can self-submit. */
    withWalletClient?: boolean;
    /** Forward to the SDK builder so NoteManager + PaymentRequestService persist. */
    persistentStorage?: PersistentStorageConfig;
};

export type CreateBobPoolSessionResult = CreatePoolSessionResult & {
    address: Hex;
};

export async function createBobPoolSession(
    options: CreateBobPoolSessionOptions = {},
): Promise<CreateBobPoolSessionResult> {
    const account = privateKeyToAccount(config.bob.privateKey as `0x${string}`);
    const walletClient = options.withWalletClient
        ? createSepoliaWalletClient(config.bob.privateKey)
        : undefined;

    const session = await createPoolSession({
        ownerAddress: account.address as Hex,
        protocolKeys: {
            privateNullifyingKey: config.bob.privateNullifyingKey,
            privateRevocableKey: config.bob.privateRevocableKey,
            viewingPrivateKey: config.bob.viewingPrivateKey,
            viewingPublicKey: config.bob.viewingPublicKey,
        },
        walletClient,
        persistentStorage: options.persistentStorage,
    });

    return { ...session, address: account.address as Hex };
}
