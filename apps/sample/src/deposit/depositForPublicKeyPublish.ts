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
 * depositFor — public-key-publish (discoverable, off-chain key) variant.
 *
 * Functionally identical to EVM-publish at the discovery layer (encrypted
 * noteData is published on-chain), but the viewing public key is supplied
 * by the caller off-chain instead of being fetched from the keystore. Use
 * this when the recipient has shared their `viewingPublicKey` directly
 * (e.g. via QR or messenger) and you don't want a keystore round-trip —
 * or when the recipient hasn't registered.
 *
 * The caller pre-computes `noteSecret` + `noteAddressHash`. Both are sent
 * encrypted within `noteData`, so the recipient learns them once they
 * call `discoverNotes()`.
 *
 * Wallet client requirement: sender's session needs a wallet interactor.
 *
 * @param senderSession   PoolSession built with a wallet client.
 * @param params          `{ tokenId, value, recipientAddress, recipientViewingPublicKey }`.
 * @param deps            Crypto + hash services from the session.
 * @returns               `{ prepared, receipt, noteSecret }`. `noteSecret`
 *                        was published encrypted; you don't need to deliver
 *                        it out-of-band.
 */
export async function depositForPublicKeyPublish(
    senderSession: PoolSession,
    params: {
        tokenId: Hex;
        value: Hex;
        recipientAddress: Hex;
        recipientViewingPublicKey: Hex;
    },
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
        discoveryData: {
            publicViewingKey: params.recipientViewingPublicKey,
            noteAddressHash,
            noteSecret,
        },
    });
    const receipt = await senderSession.executeDeposit(prepared);
    return { prepared, receipt, noteSecret };
}
