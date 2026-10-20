import type {
    Hash,
    Hex,
    PoolSession,
    PrepareWithdrawResult,
    TxReceipt,
} from "@privacy-pools-v2/evm-sdk";

/**
 * Partial withdraw via the SDK relayer.
 *
 * Same SDK call as `withdraw`, but `amount < inputNoteValue` so the SDK
 * mints a change note for the remainder. The relayer adds the change note
 * to the local NoteManager, so it appears in `exportAccount()` immediately
 * with status PENDING (or ACTIVE after `discoverNotes` flips it).
 *
 * @param session            PoolSession.
 * @param params             `{ inputCommitment, recipientAddress, amount, tokenId }`.
 * @returns                  `{ prepared, receipt }`. The change note is
 *                           `prepared.changePendingNotes[0]`.
 */
export async function partialWithdraw(
    session: PoolSession,
    params: {
        inputCommitment: Hash;
        recipientAddress: Hex;
        amount: Hex;
        tokenId: Hex;
    },
): Promise<{ prepared: PrepareWithdrawResult; receipt: TxReceipt }> {
    const prepared = await session.prepareWithdraw({
        inputCommitments: [params.inputCommitment],
        amount: params.amount,
        tokenId: params.tokenId,
        recipientAddress: params.recipientAddress,
    });
    const receipt = await session.relayWithdraw(prepared.relayerOptions[0]);
    return { prepared, receipt };
}
