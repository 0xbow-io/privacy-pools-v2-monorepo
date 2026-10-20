import type { Address, ISwapChainAdapter, YieldSwapWrapper } from "../internal.js";
import { InvalidTransactParams } from "../internal.js";

/**
 * Shared helpers for spending a yield-share note through a swap flow (`withdraw-and-swap`,
 * `reshield`, `reshield-crosschain`). The processor redeems the withdrawn ERC-4626-style shares
 * into their underlying via an owner-allowlisted zap before the swap, so every such flow quotes
 * the swap on the underlying while the relayer fee and the note stay share-denominated. Chain-
 * agnostic in shape: the allowlist check delegates to {@link ISwapChainAdapter.isApprovedZap} so
 * this file never touches an EVM ABI directly.
 */

/** The configured yield wrapper whose share token is `tokenId`, if any. */
export function yieldWrapperFor<TAddress = Address>(
    wrappers: readonly YieldSwapWrapper<TAddress>[],
    tokenId: TAddress,
    isSameToken: (a: TAddress, b: TAddress) => boolean,
): YieldSwapWrapper<TAddress> | undefined {
    return wrappers.find((w) => isSameToken(w.shareToken, tokenId));
}

/**
 * Asserts the wrapper's zap is allowlisted for the processor (`ISwapChainAdapter.isApprovedZap`),
 * which is what lets the relayer route the note through the unwrap-and-swap path. Without it the
 * relay reverts only after the proof was spent. Call before taking any relayer commitment.
 *
 * @throws {InvalidTransactParams} If the wrapper has no zap, or the zap is not allowlisted.
 */
export async function assertZapApproved<TTx, TAddress = Address>(
    swapChainAdapter: ISwapChainAdapter<TTx, TAddress>,
    processorAddress: TAddress,
    share: TAddress,
    wrapper: YieldSwapWrapper<TAddress>,
): Promise<void> {
    const zap = wrapper.zap;
    if (!zap) {
        throw new InvalidTransactParams(
            `Yield deployment for ${String(share)} has no zap configured — the unwrap-and-swap path needs the wrapper's zap`,
        );
    }
    const approved = await swapChainAdapter.isApprovedZap(zap, processorAddress);
    if (!approved) {
        throw new InvalidTransactParams(
            `Zap ${String(zap)} for yield share ${String(share)} is not allowlisted on processor ${String(processorAddress)} — it cannot swap it. Ask the operator to approve the zap.`,
        );
    }
}

/**
 * The underlying amount `netShares` redeem to right now (`previewRedeem`, the same read the
 * processor's zap performs on-chain). The share rate only rises between quote and execution
 * under yield accrual, so sizing the swap leg off this figure yields surplus (swept as dust),
 * never a shortfall.
 *
 * @throws {InvalidTransactParams} If the shares redeem to a non-positive underlying amount.
 */
export async function previewRedeemNet<TAddress = Address>(
    wrapper: YieldSwapWrapper<TAddress>,
    netShares: bigint,
): Promise<bigint> {
    const underlying = await wrapper.previewRedeem(netShares);
    if (underlying <= 0n) {
        throw new InvalidTransactParams(
            `${netShares} shares of ${String(wrapper.shareToken)} redeem to ${underlying} ${String(wrapper.underlying)} — withdraw a larger amount`,
            // Only the share figure travels: the message's two numbers are in two
            // different tokens, and `underlying` is non-positive here by the check
            // above, so there is nothing to render on that side anyway.
            {
                code: "yieldRedeemsToNothing",
                side: "spent",
                values: { shares: netShares },
            },
        );
    }
    return underlying;
}
