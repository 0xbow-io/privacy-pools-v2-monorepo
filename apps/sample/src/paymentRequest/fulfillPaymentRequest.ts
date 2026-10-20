import type {
    Hash,
    PaymentRequest,
    PoolSession,
    PrepareTransferResult,
    TxReceipt,
} from "@privacy-pools-v2/evm-sdk";

/**
 * Fulfill a payment request (sender side).
 *
 * Spends the caller's input notes into pre-computed slots from the
 * payment request. Produces a discoverable transfer: the on-chain hint is
 * the request's `tag`, so the recipient's `discoverNotes` (which scans
 * open requests) automatically matches and flips the request to FULFILLED.
 *
 * `inputCommitments.length` must be ≤ `paymentRequest.noteAddressHashes.length` —
 * the SDK consumes one slot per recipient output it produces.
 *
 * @param senderSession      PoolSession.
 * @param paymentRequest     The decoded request from the recipient.
 * @param inputCommitments   Commitments of the notes to spend.
 * @returns                  `{ prepared, receipt }`.
 */
export async function fulfillPaymentRequest(
    senderSession: PoolSession,
    paymentRequest: PaymentRequest,
    inputCommitments: Hash[],
): Promise<{ prepared: PrepareTransferResult; receipt: TxReceipt }> {
    const prepared = await senderSession.prepareFulfillPaymentRequest({
        paymentRequest,
        inputCommitments,
    });
    const { txReceipt } = await senderSession.relayTransfer(prepared.relayOptions[0]);
    return { prepared, receipt: txReceipt };
}
