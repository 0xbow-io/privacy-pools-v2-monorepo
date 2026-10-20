import type { ErrorAmounts, WithErrorAmounts } from "./amounts.js";

/** Base error class for all batch-withdraw errors. */
export class BatchWithdrawBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "BatchWithdrawBaseError";
    }
}

/** Thrown when a full-balance withdrawal selects no active notes for the asset. */
export class EmptyBatchSelection extends BatchWithdrawBaseError {
    /** @param tokenId - The asset that has no active notes. */
    constructor(tokenId: string) {
        super(`No active notes to withdraw for token ${tokenId}`);
        this.name = "EmptyBatchSelection";
    }
}

/** Thrown when the selected notes require more transacts than a single batch allows. */
export class BatchTooLarge extends BatchWithdrawBaseError {
    constructor(required: number, max: number) {
        super(`Batch would need ${required} transacts but the maximum is ${max}`);
        this.name = "BatchTooLarge";
    }
}

/**
 * Thrown when an asset's nominal `maxRelayFee` is set below the relay cost, so no
 * profitable fee can be charged and the item is not relayable. Distinct from a fee
 * that merely exceeds the item's own amount ({@link InfeasibleBatchFee}). Note that
 * `maxRelayFee == 0` means "no maximum" (uncapped), not zero — it never triggers this.
 */
export class AssetNotRelayable extends BatchWithdrawBaseError implements WithErrorAmounts {
    /** Both the cap and the relay cost are quoted in the asset being withdrawn. */
    readonly amounts: ErrorAmounts;

    /**
     * @param maxRelayFee - The asset's configured nominal cap.
     * @param relayCost - The relay cost the cap fails to cover.
     */
    constructor(maxRelayFee: string, relayCost: string) {
        super(
            `Asset not relayable: maxRelayFee ${maxRelayFee} is below the relay cost ${relayCost}`,
        );
        this.name = "AssetNotRelayable";
        this.amounts = {
            code: "assetNotRelayable",
            side: "spent",
            values: { maxRelayFee: BigInt(maxRelayFee), relayCost: BigInt(relayCost) },
        };
    }
}

/** Thrown when a batch item's own single-tx fee exceeds the amount it withdraws. */
export class InfeasibleBatchFee extends BatchWithdrawBaseError implements WithErrorAmounts {
    /** A batch is single-asset, so the fee and the item amount share the spent token. */
    readonly amounts: ErrorAmounts;

    /**
     * @param fee - The computed per-item fee.
     * @param amountOut - The item's withdrawn amount, which cannot cover the fee.
     */
    constructor(fee: string, amountOut: string) {
        super(`Item fee ${fee} exceeds its withdrawn amount ${amountOut}`);
        this.name = "InfeasibleBatchFee";
        this.amounts = {
            code: "infeasibleBatchFee",
            side: "spent",
            values: { fee: BigInt(fee), amountOut: BigInt(amountOut) },
        };
    }
}

/**
 * Thrown when the relayer-signed `PayoutRouting[]` carried in the batch fee
 * commitment does not line up one-to-one with the locally selected note groups.
 */
export class BatchRoutingMismatch extends BatchWithdrawBaseError {
    constructor(routingCount: number, groupCount: number) {
        super(
            `Batch fee commitment encodes ${routingCount} payout routings but ${groupCount} note groups were selected`,
        );
        this.name = "BatchRoutingMismatch";
    }
}

/**
 * Thrown when a relayer-signed `PayoutRouting` pairs with the wrong note group:
 * its recipient does not match the requested recipient, or its `feeAmount`
 * exceeds the paired group's `amountOut`. Either would otherwise surface only as
 * an opaque on-chain `PoolVault_ProofContextMismatch` (or fee-cap) revert after
 * proofs are generated, so it is caught eagerly with the offending index.
 */
export class BatchRoutingInvalid extends BatchWithdrawBaseError {
    /** @param index - The batch item whose routing failed validation. */
    /** @param reason - What specifically diverged for that item. */
    constructor(index: number, reason: string) {
        super(`Batch routing for item ${index} is invalid: ${reason}`);
        this.name = "BatchRoutingInvalid";
    }
}
