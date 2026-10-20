import type {
    Hash,
    Hex,
    PoolSession,
    PrepareTransferResult,
    Secret,
    TxReceipt,
} from "@privacy-pools-v2/evm-sdk";

/**
 * Cold-start transfer to an unregistered EVM address.
 *
 * Convenience wrapper around `prepareColdStartTransfer` — the SDK generates
 * a `noteSecret` per input commitment and computes
 * `noteAddressHash = Poseidon(recipientEvmAddress, noteSecret)` internally.
 * No `publicViewingKey` is supplied, so the resulting transfer is the
 * out-of-band variant: no encrypted noteData is published, and the
 * recipient cannot auto-discover.
 *
 * Difference vs. the other transfer branches:
 *
 * - `transferToEVMAddress` — recipient must be registered; SDK fetches their
 *   viewing key from the keystore. Auto-discoverable.
 * - `transferWithPublicViewingKey` — caller supplies viewing key off-chain.
 *   Auto-discoverable.
 * - `transferBlind` — caller pre-computes `noteAddressHash` AND `noteSecret`.
 *   Sender holds the secrets.
 * - `coldTransfer` (this) — caller passes only the recipient's EVM address.
 *   The SDK generates secrets; the sender extracts the returned
 *   `noteSecretsMap` and delivers it to the recipient out-of-band, who then
 *   imports the note via `noteDiscovery/importColdStartNote.ts`.
 *
 * Use this when the recipient has only an EVM address, hasn't registered
 * a keystore, AND you don't want to compute secrets yourself.
 *
 * @param senderSession      PoolSession.
 * @param params             `{ inputCommitment, recipientEvmAddress, amount, tokenId }`.
 * @returns                  `{ prepared, receipt, noteSecretsMap }`.
 *                           `noteSecretsMap` (keyed by `noteAddressHash`)
 *                           is what the sender must deliver out-of-band.
 */
export async function coldTransfer(
    senderSession: PoolSession,
    params: {
        inputCommitment: Hash;
        recipientEvmAddress: Hex;
        amount: Hex;
        tokenId: Hex;
    },
): Promise<{
    prepared: PrepareTransferResult;
    receipt: TxReceipt;
    noteSecretsMap: Map<Hash, Secret>;
}> {
    const prepared = await senderSession.prepareColdStartTransfer({
        inputCommitments: [params.inputCommitment],
        amount: params.amount,
        tokenId: params.tokenId,
        recipientEvmAddress: params.recipientEvmAddress,
    });
    const { txReceipt } = await senderSession.relayTransfer(prepared.relayOptions[0]);
    const noteSecretsMap =
        prepared.relayOptions[0].recipient.noteSecretsMap ?? new Map<Hash, Secret>();
    return { prepared, receipt: txReceipt, noteSecretsMap };
}
