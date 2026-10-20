import type { Hex, PaymentRequest, PoolSession } from "@privacy-pools-v2/evm-sdk";

/**
 * Generate a shareable payment request (recipient side).
 *
 * Pre-computes `slots` × `(noteAddressHash, noteSecret)` pairs (default 5)
 * so a sender can produce up to `slots` recipient notes against this single
 * request — useful when the sender's transfer spans multiple input
 * commitments and emits more than one recipient output.
 *
 * The returned `PaymentRequest` is the public, shareable payload (intended
 * for QR / link encoding). The recipient also persists a private record
 * (with `paymentPrivKey`) internally — discovery uses that to decrypt
 * incoming notes tagged for this request.
 *
 * @param session   Recipient's PoolSession.
 * @param params    `{ amount, tokenId, slots? }`. `amount` is informational
 *                  (not enforced on-chain); the sender chooses what to send.
 * @returns         PaymentRequest — share with the sender out-of-band.
 */
export async function generatePaymentRequest(
    session: PoolSession,
    params: { amount: Hex; tokenId: Hex; slots?: number },
): Promise<PaymentRequest> {
    return session.generatePaymentRequest(params);
}
