import type { PoolSession, TxReceipt } from "@privacy-pools-v2/evm-sdk";

/**
 * Register the session owner's keystore.
 *
 * Combines `setAuthPolicy` (publishes `nullifyingKeyHash` + `authDigest`)
 * and `setViewingKey` (publishes `viewingPublicKey`) in one call. The SDK
 * skips both txs when `isKeystoreRegistered` is already true — calling
 * this on a registered account is a no-op (returns `[]`).
 *
 * After registration, this account becomes a valid recipient for the
 * EVM-publish branch of `depositFor` and `transfer`.
 *
 * Wallet client requirement: REQUIRED — the SDK uses the wallet
 * interactor to sign and send up to two txs.
 *
 * @param session   PoolSession built with a wallet client.
 * @returns         Receipts for any txs that were submitted (length 0, 1,
 *                  or 2 depending on prior state and `includeViewingKey`).
 */
export async function registerKeystore(session: PoolSession): Promise<TxReceipt[]> {
    return session.registerKeystore();
}
