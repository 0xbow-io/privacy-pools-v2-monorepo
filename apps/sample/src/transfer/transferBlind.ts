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
 * Blind transfer — no on-chain announcement.
 *
 * Caller pre-computes `noteAddressHash = Poseidon(recipientAddress, noteSecret)`
 * and passes it directly. The SDK does not publish noteData, so the recipient
 * cannot auto-discover. The caller transmits `noteSecret` out-of-band; the
 * recipient then imports the note manually.
 *
 * → Recipient-side import flow: `noteDiscovery/importColdStartNote.ts`.
 *   (Same path used by depositForColdStart — both produce notes with no
 *    on-chain announcement.)
 *
 * @param senderSession      PoolSession.
 * @param params             `{ inputCommitment, recipientAddress, amount, tokenId }`.
 * @param deps               Hash + crypto services from the session.
 * @returns                  `{ prepared, receipt, noteSecret }`. `noteSecret`
 *                           is the out-of-band shared secret the recipient needs.
 */
export async function transferBlind(
    senderSession: PoolSession,
    params: {
        inputCommitment: Hash;
        recipientAddress: Hex;
        amount: Hex;
        tokenId: Hex;
    },
    deps: { hashService: IHashService; cryptoService: ICryptoService },
): Promise<{
    prepared: PrepareTransferResult;
    receipt: TxReceipt;
    noteSecret: Secret;
}> {
    const noteSecret = deps.cryptoService.generateSecret();
    const noteAddressHash = deps.hashService.hash([
        params.recipientAddress,
        noteSecret,
    ]) as Hash;

    const prepared = await senderSession.prepareTransfer({
        inputCommitments: [params.inputCommitment],
        amount: params.amount,
        tokenId: params.tokenId,
        recipientNoteAddressHash: [noteAddressHash],
    });
    const { txReceipt } = await senderSession.relayTransfer(prepared.relayOptions[0]);
    return { prepared, receipt: txReceipt, noteSecret };
}
