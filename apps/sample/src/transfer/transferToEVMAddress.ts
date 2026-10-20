import type {
    Hash,
    Hex,
    PoolSession,
    PrepareTransferResult,
    TxReceipt,
} from "@privacy-pools-v2/evm-sdk";

/**
 * Discoverable transfer to an EVM address.
 *
 * The SDK fetches the recipient's viewing public key from the on-chain
 * keystore and publishes encrypted noteData. The recipient finds the new
 * note via `discoverNotes()`.
 *
 * Pre-condition the integrator must guarantee: `recipientAddress` has a
 * registered keystore. If unregistered, the SDK auto-falls-back to the
 * out-of-band path — which would still succeed but the recipient would
 * not auto-discover (not what this branch demonstrates).
 *
 * Wallet client requirement: NOT needed for `prepareTransfer` itself, but
 * `relayTransfer` calls a relayer over HTTP and submits via the relayer's
 * own signer; the sender's session does not need to sign. This is the key
 * UX win of relayed transfers — the sender never holds the gas-paying key.
 *
 * @param senderSession      PoolSession (no wallet client required).
 * @param params             `{ inputCommitment, recipientAddress, amount, tokenId }`.
 * @returns                  `{ prepared, receipt }`. The recipient note's
 *                           commitment is `prepared.executeOptions.recipientPendingNotes[0].commitment`.
 */
export async function transferToEVMAddress(
    senderSession: PoolSession,
    params: {
        inputCommitment: Hash;
        recipientAddress: Hex;
        amount: Hex;
        tokenId: Hex;
    },
): Promise<{ prepared: PrepareTransferResult; receipt: TxReceipt }> {
    const prepared = await senderSession.prepareTransfer({
        inputCommitments: [params.inputCommitment],
        amount: params.amount,
        tokenId: params.tokenId,
        recipientDiscoveryData: { evmAddress: params.recipientAddress },
    });
    const { txReceipt } = await senderSession.relayTransfer(prepared.relayOptions[0]);
    return { prepared, receipt: txReceipt };
}
