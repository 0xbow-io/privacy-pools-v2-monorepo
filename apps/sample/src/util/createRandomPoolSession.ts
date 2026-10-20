import type { Hex } from "@privacy-pools-v2/evm-sdk";

import { createAccountKeys, type AccountKeyMaterial } from "./createKeys.js";
import { createPoolSession, type CreatePoolSessionResult } from "./createPoolSession.js";
import { createSepoliaWalletClient } from "./createWalletClient.js";

export type CreateRandomPoolSessionOptions = {
    /** When true, attaches a viem wallet client so the session can self-submit. */
    withWalletClient?: boolean;
};

export type CreateRandomPoolSessionResult = CreatePoolSessionResult & {
    address: Hex;
    keys: AccountKeyMaterial;
};

/**
 * Generate a fresh viem account + protocol keys per call and build a PoolSession
 * around them. The "guaranteed-uninvolved user" — by construction has no on-chain
 * footprint (no keystore registration, no notes), making example flows that need
 * an unregistered counterparty (cold-start, blind transfer) order-independent.
 */
export async function createRandomPoolSession(
    options: CreateRandomPoolSessionOptions = {},
): Promise<CreateRandomPoolSessionResult> {
    const keys = createAccountKeys();
    const walletClient = options.withWalletClient
        ? createSepoliaWalletClient(keys.walletPrivateKey)
        : undefined;

    const session = await createPoolSession({
        ownerAddress: keys.address,
        protocolKeys: {
            privateNullifyingKey: keys.privateNullifyingKey,
            privateRevocableKey: keys.privateRevocableKey,
            viewingPrivateKey: keys.viewingPrivateKey,
            viewingPublicKey: keys.viewingPublicKey,
        },
        walletClient,
    });

    return { ...session, address: keys.address, keys };
}
