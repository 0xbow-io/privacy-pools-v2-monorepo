import type { Address } from "viem";

/**
 * Pre-generated test addresses for e2e relay tests.
 *
 * All addresses are impersonated + funded on anvil (no private keys needed).
 * Convention: prefix encodes role, index byte after prefix, padded with zeros, ending in `fa7`.
 *
 * - Depositor (`0xaaa...fa7`): single depositor that deposits 6 accounts
 *   reused across all NxM circuit variants (withdrawal + transfer) via
 *   anvil snapshot/revert.
 * - Transfer recipients (`0xbbb{NN}...fa7`): just need a noteAddressHash,
 *   no deposit or keystore registration required.
 * - Withdrawal recipients (`0x000{NN}...fa7`): external addresses that
 *   receive withdrawn ETH.
 */

/** Single depositor for all test accounts (both withdrawal and transfer). */
export const DEPOSITOR: Address = "0xaaA0000000000000000000000000000000000FA7";

/** 11 transfer recipient addresses — just need noteAddressHash. */
export const TRANSFER_RECIPIENTS: Address[] = [
    "0xBbb0000000000000000000000000000000000Fa7",
    "0xbbb0100000000000000000000000000000000fA7",
    "0xBBb0200000000000000000000000000000000fA7",
    "0xbBb0300000000000000000000000000000000fA7",
    "0xBBB0400000000000000000000000000000000FA7",
    "0xBBb0500000000000000000000000000000000Fa7",
    "0xbBb0600000000000000000000000000000000fA7",
    "0xBbb0700000000000000000000000000000000fA7",
    "0xbbB0800000000000000000000000000000000FA7",
    "0xBbb0900000000000000000000000000000000Fa7",
    "0xBBb0a00000000000000000000000000000000FA7",
];

/** 5 withdrawal recipient addresses — receive withdrawn ETH. */
export const WITHDRAWAL_RECIPIENTS: Address[] = [
    "0x0000100000000000000000000000000000000fa7",
    "0x0000200000000000000000000000000000000FA7",
    "0x0000300000000000000000000000000000000FA7",
    "0x0000400000000000000000000000000000000fa7",
    "0x0000500000000000000000000000000000000fA7",
];
