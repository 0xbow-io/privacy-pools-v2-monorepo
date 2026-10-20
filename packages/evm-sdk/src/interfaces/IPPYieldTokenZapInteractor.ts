import type { Address, PreparedTransaction } from "../internal.js";

/**
 * Encode surface for the `PPYieldTokenZap` — the stateless wrap/unwrap helper. Phase 1 exposes the
 * loose-ppShare→underlying exit (`redeemToUnderlying`), the one-call path a holder of loose ppUSDC
 * (notably after a ragequit) uses to get back to USDC without receiving the raw aToken.
 */
export interface IPPYieldTokenZapInteractor {
    /**
     * Returns the zap contract address.
     *
     * @returns The zap contract address.
     */
    getAddress(): Address;

    /**
     * Encodes `PPYieldTokenZap.redeemToUnderlying(shares, receiver)`: unwrap `shares` loose ppUSDC to the
     * underlying (USDC) and send it to `receiver`.
     *
     * @param shares - The ppUSDC shares to redeem.
     * @param receiver - The address to receive the underlying.
     * @returns The prepared transaction (to/data/value).
     * @throws {ContractInteractorBaseError}
     */
    encodeRedeemToUnderlying(shares: bigint, receiver: Address): PreparedTransaction;
}
