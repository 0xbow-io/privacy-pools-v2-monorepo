import type { Announcement, EvmAddress, Hex } from "./types.js";
import { StealthAddressAnnouncementError } from "./errors.js";

/**
 * The minimum recipient-side view of a PoolVault.Withdrawal event. The
 * scanner reads withdrawal logs by transaction hash; both the destination
 * address and the tx hash are load-bearing for the v4 binding check.
 *
 * Producing this struct lives outside the stealth module - PP's existing
 * scanner / log-reader code already does it under the audit-receipt and
 * payment-requests services. This module just consumes it.
 */
export interface WithdrawalLogEvent {
    readonly txHash: Hex;
    readonly destination: EvmAddress;
}

/**
 * Recipient-side STLTH-18 binding verifier.
 *
 * After `scanAnnouncement` returns a positive match, the recipient's wallet
 * MUST also confirm that a `PoolVault.Withdrawal` event in the SAME on-chain
 * transaction as the announcement sent funds to the announced stealth
 * address.
 *
 * v4 hardening (audit BIND-01): the verifier now requires the caller to
 * supply `announcementTxHash` and refuses any withdrawal whose `txHash` does
 * not equal it. Without this, a caller could pass withdrawals from an
 * unrelated transaction and get a false-positive accept. Throwing rather
 * than returning false on a tx-hash mismatch surfaces the misuse loudly
 * rather than silently rejecting.
 *
 * Inputs:
 *   announcementTxHash   - the tx hash that emitted the Announcement event
 *   announcement         - the announcement payload (in-memory)
 *   withdrawalsInSameTx  - all PoolVault.Withdrawal events extracted from
 *                          the on-chain receipt of `announcementTxHash`.
 *                          Every element's `txHash` MUST equal
 *                          `announcementTxHash`; mixing-in withdrawals from
 *                          a different tx throws.
 *
 * Returns `true` iff at least one withdrawal in the same tx paid the
 * announced stealth address.
 *
 * Pure / structural; no curve math.
 */
export const verifyAnnouncementBindsToWithdrawal = (
    announcementTxHash: Hex,
    announcement: Announcement,
    withdrawalsInSameTx: readonly WithdrawalLogEvent[],
): boolean => {
    const txLower = announcementTxHash.toLowerCase();
    for (const w of withdrawalsInSameTx) {
        if (w.txHash.toLowerCase() !== txLower) {
            throw new StealthAddressAnnouncementError(
                `verifyAnnouncementBindsToWithdrawal: withdrawal from tx ${w.txHash} ` +
                    `does not belong to announcement tx ${announcementTxHash}. ` +
                    `Caller must filter withdrawals by tx hash before passing them in.`,
            );
        }
    }
    const announced = announcement.stealthAddress.toLowerCase();
    for (const w of withdrawalsInSameTx) {
        if (w.destination.toLowerCase() === announced) return true;
    }
    return false;
};
