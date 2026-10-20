import type { Account, Chain, Transport, WalletClient } from "viem";

import type {
    Hex,
    PoolSession,
    RotateRevocableKeyOutcome,
} from "@privacy-pools-v2/evm-sdk";

import { buildSecretDerivationPayload } from "./secretDerivationPayload.js";

/**
 * Rotate the session owner's revocable key.
 *
 * Builds the canonical EIP-712 secret-derivation payload, asks the wallet
 * client to sign it, and forwards the signature to
 * `poolSession.rotateRevocableKey`. The SDK derives the next revocable key
 * via two-stage HKDF on the signature, encodes `updateAuthPolicy`, submits
 * the tx, and (on success) updates the in-memory KeystoreManager so the new
 * key is active immediately.
 *
 * The rotation index advances by 1 — the SDK does not accept an explicit
 * target index. To recover the index from chain after a state wipe, scan
 * the on-chain `authorizerDigest` against candidate
 * `Poseidon(privateRevocableKey_n)` values (planned helper).
 *
 * Wallet client requirement: REQUIRED — used both for the EIP-712 signature
 * and for submitting the `updateAuthPolicy` transaction.
 *
 * @param session       PoolSession built with a wallet client.
 * @param walletClient  Viem wallet client used to sign the EIP-712 payload.
 * @returns             Rotation outcome: receipt, superseded/active digests,
 *                      and `newRevocableKeyIndex` — the value the integrator
 *                      must persist together with the receipt so the next
 *                      session re-derives the right `privateRevocableKey`.
 */
export async function rotateRevocableKey(
    session: PoolSession,
    walletClient: WalletClient<Transport, Chain, Account>,
): Promise<RotateRevocableKeyOutcome> {
    const signerAddress = walletClient.account.address as Hex;
    const typedData = buildSecretDerivationPayload(signerAddress);

    const signature = (await walletClient.signTypedData({
        account: walletClient.account,
        domain: typedData.domain,
        types: { SecretDerivation: typedData.types.SecretDerivation },
        primaryType: typedData.primaryType,
        message: typedData.message,
    })) as Hex;

    return session.rotateRevocableKey({
        signature,
        signerAddress,
        addressHash: typedData.message.addressHash,
    });
}
