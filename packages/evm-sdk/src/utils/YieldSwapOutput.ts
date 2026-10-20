import { decodeFunctionData } from "viem";

import type {
    Address,
    PrepareDepositResult,
    PreparedTransaction,
    YieldDepositForRecipient,
    YieldDepositTarget,
    YieldSwapDepositTarget,
} from "../internal.js";
import {
    InvalidTransactParams,
    NATIVE_ASSET_ADDRESS,
    PP_ROUTER_DEPOSIT_ABI,
    PP_ROUTER_DEPOSIT_NATIVE_ABI,
} from "../internal.js";

/** Resolve by share only. An underlying address remains a plain deposit target. */
export function yieldDepositTargetFor(
    targets: YieldDepositTarget[],
    share: Address,
): YieldDepositTarget | undefined {
    return targets.find(
        ({ deployment }) => deployment.ppUSDC.toLowerCase() === share.toLowerCase(),
    );
}

/** Token LiFi delivers to the configured router. */
export function yieldDepositFundingToken(target: YieldDepositTarget): Address {
    return target.deployment.nativeMode ? NATIVE_ASSET_ADDRESS : target.deployment.underlying;
}

/**
 * Size and prepare a router deposit funded by LiFi. Never returns wallet approvals.
 *
 * @param recipient - Optional third-party recipient identity (reshield-and-transfer's yield-share
 *   output). Omitted: self-deposit, unchanged from before. Present: routes through
 *   `prepareYieldDepositFor` instead, and the returned `noteSecret` (when the out-of-band fallback
 *   fired) is forwarded on the result.
 */
export async function prepareYieldSwapDeposit(
    target: YieldDepositTarget,
    budget: bigint,
    headroomPpm?: bigint,
    recipient?: YieldDepositForRecipient,
): Promise<PrepareDepositResult<PreparedTransaction, Address>> {
    const sized = await target.deposit.sizeSharesForBudget(budget, headroomPpm);
    const sizing = {
        value: sized.shares,
        maxUnderlyingIn: sized.maxUnderlyingIn,
        fundingSource: "executor" as const,
    };
    const prepared = recipient
        ? recipient.noteAddressHash
            ? await target.deposit.prepareYieldDepositFor({
                  ...sizing,
                  noteAddressHash: recipient.noteAddressHash,
                  noteData: recipient.noteData,
                  depositSecret: recipient.depositSecret,
              })
            : await target.deposit.prepareYieldDepositFor({
                  ...sizing,
                  discoveryData: recipient.discoveryData,
              })
        : await target.deposit.prepareYieldDeposit(sizing);
    return {
        pendingNote: prepared.pendingNote,
        depositTx: prepared.depositTx,
        approvalTxs: [],
        approvalTx: null,
        noteSecret: prepared.noteSecret,
    };
}

/** Check the proof's share/value and the encoded cap against the prepared metadata. */
export function assertYieldDepositMatches(
    target: YieldDepositTarget,
    result: Pick<PrepareDepositResult<PreparedTransaction, Address>, "depositTx" | "pendingNote">,
    budget?: bigint,
): void {
    const { deployment } = target;
    const { depositTx, pendingNote } = result;
    if (depositTx.to.toLowerCase() !== deployment.ppRouter.toLowerCase()) {
        throw new InvalidTransactParams(
            "Yield deposit target does not match the configured router.",
        );
    }
    let signals: readonly bigint[];
    let cap: bigint;
    try {
        if (deployment.nativeMode) {
            const decoded = decodeFunctionData({
                abi: PP_ROUTER_DEPOSIT_NATIVE_ABI,
                data: depositTx.data,
            });
            signals = decoded.args[0].pubSignals;
            cap = BigInt(depositTx.value);
        } else {
            const decoded = decodeFunctionData({
                abi: PP_ROUTER_DEPOSIT_ABI,
                data: depositTx.data,
            });
            signals = decoded.args[0].pubSignals;
            cap = decoded.args[3];
            if (BigInt(depositTx.value) !== 0n) throw new Error("ERC-20 deposit carries native value.");
        }
    } catch {
        throw new InvalidTransactParams(
            "Yield deposit calldata or native value does not match the configured router mode.",
        );
    }
    if (
        signals[1] !== BigInt(deployment.ppUSDC) ||
        signals[1] !== BigInt(pendingNote.tokenId) ||
        signals[2] !== BigInt(pendingNote.value)
    ) {
        throw new InvalidTransactParams("Yield deposit proof does not match the share note.");
    }
    if (cap <= 0n || (budget !== undefined && cap !== budget)) {
        throw new InvalidTransactParams("Yield deposit cap does not match totalDepositCost.");
    }
}

/**
 * Adapts an EVM {@link YieldDepositTarget} (a `session.yields` entry) to core-sdk's chain-agnostic
 * {@link YieldSwapDepositTarget}, so core's swap/reshield/swap-deposit sessions can size, prepare
 * and verify a router deposit without touching the router ABI.
 */
export function toYieldSwapDepositTarget(
    target: YieldDepositTarget,
): YieldSwapDepositTarget<PreparedTransaction, Address> {
    return {
        chainId: target.chainId,
        shareToken: target.deployment.ppUSDC,
        router: target.deployment.ppRouter,
        fundingToken: yieldDepositFundingToken(target),
        sizeSharesForBudget: (budget, headroomPpm) =>
            target.deposit.sizeSharesForBudget(budget, headroomPpm),
        prepareSwapDeposit: (budget, headroomPpm, recipient) =>
            prepareYieldSwapDeposit(target, budget, headroomPpm, recipient),
        assertDepositMatches: (result, budget) => assertYieldDepositMatches(target, result, budget),
    };
}
