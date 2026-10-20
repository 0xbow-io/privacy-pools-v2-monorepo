/**
 * Sizing margins shared by every chain's yield sessions (see `PoolSessionYieldDeposit` /
 * `PoolSessionYieldWithdraw`). Moved here from evm-sdk when the sessions became chain-agnostic.
 */

/** Basis-points denominator (100% = 10_000 bps). */
export const YIELD_BPS_DENOMINATOR = 10_000n;

/**
 * Default slippage floor (basis points) subtracted from the router's `quoteWithdraw` to derive
 * `minUnderlyingOut`, protecting the recipient leg against an adverse rate move or mid-flight fee
 * bump between quote and execution. Callers can override per withdrawal.
 */
export const WITHDRAW_SLIPPAGE_BPS = 100n; // -1%

/** Parts-per-million denominator (100% = 1_000_000 ppm). */
export const YIELD_PPM_DENOMINATOR = 1_000_000n;

/**
 * Rate headroom (parts per million) an exact-shares deposit tolerates between quote and
 * execution, added to the router's quoted `underlyingNeeded` to form the default
 * `maxUnderlyingIn` spend cap. A wrap has no slippage: there is no counterparty and no price
 * impact. In a normally funded vault two things move the underlying price of a fixed share amount
 * before the transaction executes: interest accrual on the vault's lending position (EVM: an Aave aToken; Stellar: a Blend b-token) (about 1e-9 of the rate
 * per SECOND, ~1.1e-8 per 12 s block, ~5.7e-8 per minute at 3% APR) and integer rounding
 * (`previewMint` rounds up by at most one unit). 1 ppm covers ~17 minutes of accrual at 3% APR
 * (~5 at 10%); the cap is floored at one whole underlying unit for tiny deposits. The window
 * shrinks when the vault's net backing is tiny relative to its gross aToken balance (unclaimed
 * yield fees amplify the net rate) or to the deposit (a single raw unit of accrual then moves the
 * quote by many units); a caller that knows the vault state can pass its own cap. A deposit that
 * outlives its cap reverts with the router's slippage error (EVM `PPRouter_SlippageExceeded`, Stellar `SlippageExceeded`) and is simply retried with a fresh
 * quote; it never pays more than the cap.
 *
 * The previous design took a 0.5% "discount" off the SHARES instead (`DEPOSIT_SHARES_DISCOUNT_BPS`
 * = 50). Since the shares are the fixed leg, that discount was a silent 0.5% under-deposit:
 * 100 USDC bought 99.49 ppUSDC and 0.50 USDC stayed in the wallet (mainnet, 2026-09-05).
 */
export const DEPOSIT_RATE_HEADROOM_PPM = 1n;
