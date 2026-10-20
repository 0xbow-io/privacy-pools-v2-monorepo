import type { Address, YieldSwapDepositTarget } from "../internal.js";

/**
 * The configured yield-share deposit target whose share token is `share`, if any. Resolves by
 * share only — an underlying address remains a plain deposit target.
 */
export function yieldSwapDepositTargetFor<TTx, TAddress = Address>(
    targets: readonly YieldSwapDepositTarget<TTx, TAddress>[],
    share: TAddress,
    isSameToken: (a: TAddress, b: TAddress) => boolean,
): YieldSwapDepositTarget<TTx, TAddress> | undefined {
    return targets.find((t) => isSameToken(t.shareToken, share));
}
