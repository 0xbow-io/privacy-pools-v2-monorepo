import type { Address, PreparedTransaction, IYieldTokenInteractor } from "../internal.js";

/**
 * Read-only interactions with the ppUSDC (`PPYieldToken`) ERC-4626 share wrapper.
 *
 * Core-sdk's {@link IYieldTokenInteractor} (reads used to size deposits and value notes) plus the
 * EVM-only direct `redeem` exit to the aToken.
 */
export interface IPPYieldTokenInteractor extends IYieldTokenInteractor<Address> {
    /**
     * Encodes a direct wrapper `redeem(shares, receiver, owner)` — the always-available exit that
     * pays out the aToken (aUSDC) and never calls Aave. Requires the caller to hold `shares` of
     * ppUSDC in `owner` (e.g. after a ragequit unshields the note). Does not send.
     *
     * @param shares - ppUSDC shares to redeem, raw 18-decimal integer.
     * @param receiver - Address to receive the aUSDC. Must be non-zero.
     * @param owner - Address that holds the shares (whose allowance/balance is spent). Must be non-zero.
     * @returns A prepared transaction ready for submission.
     * @throws {YieldSessionBaseError}
     */
    encodeRedeem(shares: bigint, receiver: Address, owner: Address): PreparedTransaction;
}
