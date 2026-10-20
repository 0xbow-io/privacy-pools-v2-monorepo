import type { Address, IYieldRouterInteractor } from "../internal.js";

/**
 * Read-only interactions with the combined `PPRouter` (wraps USDC<->ppUSDC and shields/unshields
 * via the pool): core-sdk's {@link IYieldRouterInteractor} over Aave. `quoteWithdraw` redeems
 * ppUSDC to the aToken, ~1:1 with the underlying; `supplyBufferUnits` is the zap's constant
 * {@link ZAP_SUPPLY_BUFFER_UNITS}.
 */
export type IPPRouterInteractor = IYieldRouterInteractor<Address>;
