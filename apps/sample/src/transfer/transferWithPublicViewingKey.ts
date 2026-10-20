import type {
    Hash,
    Hex,
    ICryptoService,
    IHashService,
    PoolSession,
    PrepareTransferResult,
    Secret,
    TxReceipt,
} from "@privacy-pools-v2/evm-sdk";

/**
 * Discoverable transfer with caller-supplied viewing key.
 *
 * Same outcome as `transferToEVMAddress` — encrypted noteData is published,
 * recipient finds via `discoverNotes()` — but the SDK skips the keystore
 * lookup. Use when you have the recipient's `viewingPublicKey` from a side
 * channel and don't want the on-chain RPC round trip, or when the recipient
 * has not registered their keystore.
 *
 * The caller pre-computes the per-output `noteSecret` and packs it into a
 * `noteSecretsMap` keyed by `noteAddressHash`. The SDK encrypts these into
 * the noteData payload along with the rest, so the recipient learns them
 * once they decrypt.
 *
 * @param senderSession      PoolSession.
 * @param params             `{ inputCommitment, recipientAddress, recipientViewingPublicKey, amount, tokenId }`.
 * @param deps               Hash + crypto services from the session.
 * @returns                  `{ prepared, receipt }`.
 */
export async function transferWithPublicViewingKey(
    senderSession: PoolSession,
    params: {
        inputCommitment: Hash;
        recipientAddress: Hex;
        recipientViewingPublicKey: Hex;
        amount: Hex;
        tokenId: Hex;
    },
    deps: { hashService: IHashService; cryptoService: ICryptoService },
): Promise<{ prepared: PrepareTransferResult; receipt: TxReceipt }> {
    const noteSecret = deps.cryptoService.generateSecret();
    const noteAddressHash = deps.hashService.hash([
        params.recipientAddress,
        noteSecret,
    ]) as Hash;
    const noteSecretsMap = new Map<Hash, Secret>([[noteAddressHash, noteSecret]]);

    const prepared = await senderSession.prepareTransfer({
        inputCommitments: [params.inputCommitment],
        amount: params.amount,
        tokenId: params.tokenId,
        recipientDiscoveryData: {
            publicViewingKey: params.recipientViewingPublicKey,
            noteSecretsMap,
        },
    });
    const { txReceipt } = await senderSession.relayTransfer(prepared.relayOptions[0]);
    return { prepared, receipt: txReceipt };
}
