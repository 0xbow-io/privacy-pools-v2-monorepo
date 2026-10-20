import type {
    Hex,
    PoolSession,
    PrepareDepositResult,
    TxReceipt,
} from "@privacy-pools-v2/evm-sdk";

/**
 * depositFor — EVM-publish (discoverable) variant.
 *
 * Use this when the recipient HAS registered their keystore on-chain.
 * The SDK fetches their viewing public key from the keystore contract,
 * encrypts noteData with it, and publishes the encrypted blob on-chain.
 * The recipient discovers the note by calling `discoverNotes()` — no
 * out-of-band step required.
 *
 * Pre-condition the integrator must guarantee: `recipientAddress` has
 * already called `setAuthPolicy` + `setViewingKey`. If they haven't, the
 * SDK auto-falls-back to "out-of-band" semantics (no announcement,
 * `noteSecret` returned to the caller) — that's a different path; if you
 * want true cold-start use `depositForColdStart` explicitly.
 *
 * Wallet client requirement: sender's session needs a wallet interactor.
 *
 * Note persistence: depositor ≠ note owner, so nothing is added locally on
 * the sender side. The recipient picks it up via `discoverNotes`.
 *
 * @param senderSession    PoolSession built with a wallet client.
 * @param params           `{ tokenId, value, recipientAddress }`.
 * @returns                `{ prepared, receipt }` — `prepared.pendingNote.commitment`
 *                         is the on-chain commitment.
 */
export async function depositForEVMPublish(
    senderSession: PoolSession,
    params: { tokenId: Hex; value: Hex; recipientAddress: Hex },
): Promise<{ prepared: PrepareDepositResult; receipt: TxReceipt }> {
    const prepared = await senderSession.prepareDepositFor({
        tokenId: params.tokenId,
        value: params.value,
        discoveryData: { evmAddress: params.recipientAddress },
    });
    const receipt = await senderSession.executeDeposit(prepared);
    return { prepared, receipt };
}
