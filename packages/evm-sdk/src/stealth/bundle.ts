import type { EvmCall } from "./announce.js";
import type { Announcement, EvmAddress, Hex } from "./types.js";
import { buildAnnounceCall } from "./announce.js";
import { StealthAddressAnnouncementError } from "./errors.js";

/**
 * The sender-side bundle passed to the relayer. STLTH-03 requires atomic
 * submission of both calls in a single EVM transaction (multicall-style).
 *
 * STLTH-18 (v3): the bundle composer asserts that the withdrawal's destination
 * address equals the announcement's stealth address. A relayer that swaps one
 * but not the other (e.g. by mutating the announce calldata mid-flight while
 * leaving the withdraw intact) would produce an on-chain trace where the
 * recipient's binding-verifier (see `discoveryBinding.ts`) refuses to accept
 * the announcement.
 */
export interface StealthWithdrawalBundle {
    readonly withdraw: EvmCall;
    readonly announce: EvmCall;
}

/**
 * Caller-provided shape: the PP withdrawal call plus an out-of-band declaration
 * of its destination. We can't decode the withdrawal proof's calldata here
 * (PP's withdraw arg layout lives elsewhere); the caller is the only party who
 * already knows the destination at the moment they construct the proof, so
 * they declare it. The composer then asserts it matches the announcement.
 *
 * Misuse (caller lies about destination): the resulting bundle would post an
 * announcement that doesn't match what actually happens on-chain. The
 * recipient's `verifyAnnouncementBindsToWithdrawal` would still reject it, so
 * the misuse is detected at recovery time, but the user wastes a withdrawal.
 * For defense in depth we recommend the caller pass `declaredDestination`
 * directly from the same SDK call that produced the proof's public signals.
 */
export interface DeclaredWithdrawCall {
    readonly to: EvmAddress;
    readonly data: Hex;
    /** The destination address that the PP withdrawal proof's public signals attest to. */
    readonly declaredDestination: EvmAddress;
}

/**
 * Compose the atomic (withdraw, announce) bundle that the relayer must submit
 * as a single EVM transaction. STLTH-18 binding is enforced here: the
 * announcement's `stealthAddress` MUST equal the declared withdrawal
 * destination. Throws `StealthAddressAnnouncementError` if not.
 */
export const composeWithdrawalBundle = (
    withdrawCall: DeclaredWithdrawCall,
    announcement: Announcement,
    announcerAddress: EvmAddress,
): StealthWithdrawalBundle => {
    if (
        withdrawCall.declaredDestination.toLowerCase() !== announcement.stealthAddress.toLowerCase()
    ) {
        throw new StealthAddressAnnouncementError(
            `STLTH-18 binding violation: withdrawal destination (${withdrawCall.declaredDestination}) ` +
                `does not equal announcement stealth address (${announcement.stealthAddress}). ` +
                `Refusing to compose a bundle whose announcement and destination are decoupled.`,
        );
    }
    return {
        withdraw: { to: withdrawCall.to, data: withdrawCall.data },
        announce: buildAnnounceCall(announcement, announcerAddress),
    };
};
