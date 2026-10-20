import type { Hex, PoolSession } from "@privacy-pools-v2/evm-sdk";
import type { Account, Chain, Transport, WalletClient } from "viem";

import { buildSecretDerivationPayload } from "./secretDerivationPayload.js";

/**
 * Discover the active revocable-key rotation index from chain.
 *
 * Builds the canonical EIP-712 secret-derivation payload, signs it, and asks
 * the SDK to scan candidate `Poseidon(privateRevocableKey_n)` values against
 * the on-chain `authorizerDigest` recovered from `AuthPolicySet` /
 * `AuthPolicyUpdated` events. Returns the matching `n`.
 *
 * Cold-start recovery flow: the SDK does not persist the rotation index, so
 * an integrator that wiped local storage uses this helper to rebuild the
 * index before initialising the next `PoolSession`.
 *
 * Wallet client requirement: REQUIRED — used only for the EIP-712 signature;
 * no transaction is submitted.
 *
 * @param session       PoolSession built with a wallet client.
 * @param walletClient  Viem wallet client used to sign the EIP-712 payload.
 * @param gapLimit      Optional override for the scan window (default 20).
 * @returns             Active rotation index `n`.
 */
export async function discoverRevocableKeyIndex(
    session: PoolSession,
    walletClient: WalletClient<Transport, Chain, Account>,
    gapLimit?: number,
): Promise<Hex> {
    const signerAddress = walletClient.account.address;
    const typedData = buildSecretDerivationPayload(signerAddress);

    const signature = await walletClient.signTypedData({
        account: walletClient.account,
        domain: typedData.domain,
        types: { SecretDerivation: typedData.types.SecretDerivation },
        primaryType: typedData.primaryType,
        message: typedData.message,
    });

    return session.discoverRevocableKeyIndex(
        {
            signature,
            signerAddress,
            addressHash: typedData.message.addressHash,
        },
        gapLimit,
    );
}

