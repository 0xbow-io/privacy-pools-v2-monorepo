import type {
    Hash,
    Hex,
    ICryptoService,
    IHashService,
    PoolSession,
    PrepareDepositResult,
    Secret,
    TxReceipt,
} from "@privacy-pools-v2/evm-sdk";

/**
 * depositFor — cold-start (blind) variant.
 *
 * Use this when the recipient has only an EVM address and no on-chain
 * keystore registration. The SDK takes the blind path: caller pre-computes
 * `noteAddressHash = Poseidon(recipientAddress, noteSecret)` and passes it
 * directly. No noteData is published on-chain, so the recipient cannot
 * auto-discover the note.
 *
 * The caller (sender) holds `noteSecret` and must transmit it to the
 * recipient out-of-band — encrypted DM, sealed envelope, etc.
 *
 * → Recipient-side import flow: `noteDiscovery/importColdStartNote.ts`.
 *
 * Wallet client requirement: the sender's session MUST have a wallet
 * interactor — `executeDeposit` signs and sends the tx.
 *
 * Note persistence: because the depositor is NOT the note owner, the note
 * is NOT added to the sender's NoteManager. The recipient is responsible
 * for persisting it locally via `importAccount` — see linked file above.
 *
 * @param senderSession      PoolSession built with a wallet client.
 * @param params             `{ tokenId, value, recipientAddress }`.
 * @param deps               Crypto + hash services (read off the session).
 * @returns                  `{ prepared, receipt, noteSecret }`.
 *                           `noteSecret` is the out-of-band shared secret
 *                           the recipient needs.
 */
export async function depositForColdStart(
    senderSession: PoolSession,
    params: { tokenId: Hex; value: Hex; recipientAddress: Hex },
    deps: { hashService: IHashService; cryptoService: ICryptoService },
): Promise<{
    prepared: PrepareDepositResult;
    receipt: TxReceipt;
    noteSecret: Secret;
}> {
    const noteSecret = deps.cryptoService.generateSecret();
    const noteAddressHash = deps.hashService.hash([
        params.recipientAddress,
        noteSecret,
    ]) as Hash;

    const prepared = await senderSession.prepareDepositFor({
        tokenId: params.tokenId,
        value: params.value,
        noteAddressHash,
    });
    const receipt = await senderSession.executeDeposit(prepared);
    return { prepared, receipt, noteSecret };
}
