import type { Hash } from "../internal.js";
import type { ErrorAmounts, WithErrorAmounts } from "./amounts.js";

/** Base error class for all PoolSessionTransact errors. */
export class PoolSessionTransactBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "PoolSessionTransactBaseError";
    }
}

/** Thrown when the constructor config is invalid. */
export class InvalidPoolSessionTransactConfig extends PoolSessionTransactBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid pool session transact config: ${reason}`);
        this.name = "InvalidPoolSessionTransactConfig";
    }
}

/** Thrown when transfer or withdraw parameters fail input validation. */
export class InvalidTransactParams
    extends PoolSessionTransactBaseError
    implements WithErrorAmounts
{
    /**
     * Set only by the throw sites whose `reason` interpolates token amounts, so a
     * caller can render them instead of parsing the sentence. Absent on the many
     * sites that report an address, a chain id or a malformed field.
     */
    readonly amounts?: ErrorAmounts;

    /**
     * @param reason - Validation failure detail.
     * @param amounts - The token figures inside `reason`, when it carries any.
     */
    constructor(reason: string, amounts?: ErrorAmounts) {
        super(`Invalid transact params: ${reason}`);
        this.name = "InvalidTransactParams";
        this.amounts = amounts;
    }
}

/** Thrown when an input note is not in ACTIVE status. */
export class TransactNoteNotActive extends PoolSessionTransactBaseError {
    /** @param commitment - The commitment of the non-active note. */
    constructor(commitment: Hash) {
        super(`Transact failed: note ${commitment} is not ACTIVE`);
        this.name = "TransactNoteNotActive";
    }
}

/** Thrown when input notes have insufficient value for the transfer or withdrawal amount. */
export class InsufficientTransactValue
    extends PoolSessionTransactBaseError
    implements WithErrorAmounts
{
    /** Both figures are the notes' own token: what is being spent, never the swap output. */
    readonly amounts: ErrorAmounts;

    constructor(available: string, requested: string) {
        super(`Insufficient value for transact: available=${available}, requested=${requested}`);
        this.name = "InsufficientTransactValue";
        this.amounts = {
            code: "insufficientTransactValue",
            side: "spent",
            values: { available: BigInt(available), requested: BigInt(requested) },
        };
    }
}

export class InsufficientChangeValueForFee
    extends PoolSessionTransactBaseError
    implements WithErrorAmounts
{
    /** The change note and the relayer fee are both in the spent note's token. */
    readonly amounts: ErrorAmounts;

    constructor(totalChange: string, fee: string) {
        super(`Insufficient change value to cover fee: totalChange=${totalChange}, fee=${fee}`);
        this.name = "InsufficientChangeValueForFee";
        this.amounts = {
            code: "insufficientChangeForFee",
            side: "spent",
            values: { totalChange: BigInt(totalChange), fee: BigInt(fee) },
        };
    }
}

/** Thrown when a reshield is attempted across different chains. */
export class CrossChainReshieldNotImplemented extends PoolSessionTransactBaseError {
    constructor(withdrawChainId: number, depositChainId: number) {
        super(
            `Cross-chain reshield not implemented: withdrawal chain ${withdrawChainId} !== deposit chain ${depositChainId}`,
        );
        this.name = "CrossChainReshieldNotImplemented";
    }
}

/**
 * Thrown when an evmAddress recipient has no on-chain viewing key and the
 * caller has not opted into out-of-band fallback via
 * `recipientDiscoveryData.allowOutOfBandFallback = true`. The default refuses
 * to silently downgrade — a caller that assumed a discoverable transfer would
 * otherwise discard the only copy of the recipient note secrets.
 */
export class RecipientViewingKeyUnregistered extends PoolSessionTransactBaseError {
    constructor(recipient: string) {
        super(
            `Recipient ${recipient} has no on-chain viewing key — pass allowOutOfBandFallback to opt into out-of-band delivery`,
        );
        this.name = "RecipientViewingKeyUnregistered";
    }
}

/** Thrown when the swap output token is not enabled on the Entrypoint. */
export class AssetNotSupported extends PoolSessionTransactBaseError {
    /** @param asset - The unsupported asset address. */
    constructor(asset: string) {
        super(`Asset ${asset} is not enabled on the Entrypoint — deposit would revert`);
        this.name = "AssetNotSupported";
    }
}

/**
 * Thrown when a reshield-and-transfer's `outputToken` is neither a configured yield deposit
 * target nor servable as a plain deposit (the session was built without a `depositDelegate`, or
 * this is the cross-chain session, which is yield-share only). It fails fast here instead of
 * being silently estimated/quoted as a deposit the session cannot build.
 */
export class YieldTargetNotConfigured extends PoolSessionTransactBaseError {
    /** @param outputToken - The token address that is neither a yield deposit target nor servable as a plain deposit. */
    constructor(outputToken: string) {
        super(
            `Output token ${outputToken} has no configured yield deposit target and this session has no plain-deposit delegate — it cannot be served by reshield-and-transfer`,
        );
        this.name = "YieldTargetNotConfigured";
    }
}

/** Thrown when a reshield note value is below the Entrypoint's minimum deposit amount. */
export class DepositBelowMinimum extends PoolSessionTransactBaseError implements WithErrorAmounts {
    /**
     * Denominated in the DESTINATION pool's token, not in whatever is being
     * spent to get there: a reshield out of ppUSDC into ppUSDT reports ppUSDT.
     */
    readonly amounts: ErrorAmounts;

    constructor(value: string, minAmount: string) {
        super(`Deposit value ${value} is below the Entrypoint minimum ${minAmount}`);
        this.name = "DepositBelowMinimum";
        this.amounts = {
            code: "depositBelowMinimum",
            side: "received",
            values: { value: BigInt(value), minimum: BigInt(minAmount) },
        };
    }
}

/**
 * Thrown before proving when a Mainnet-destination reshield needs a B2 `swapValue` (the
 * LayerZero fee, with headroom) above the relayer's published `max_swap_value_wei` — the
 * relayer would refuse the quote with HTTP 400. Both figures are in the source chain's native
 * wei, so this carries them as fields rather than as note-denominated `ErrorAmounts`.
 */
export class SwapValueExceedsRelayerCap extends PoolSessionTransactBaseError {
    readonly swapValue: bigint;
    readonly maxSwapValueWei: bigint;

    constructor(swapValue: bigint, maxSwapValueWei: bigint) {
        super(
            `B2 swapValue ${swapValue} exceeds the relayer's max_swap_value_wei ${maxSwapValueWei} — the relayer would refuse this reshield`,
        );
        this.name = "SwapValueExceedsRelayerCap";
        this.swapValue = swapValue;
        this.maxSwapValueWei = maxSwapValueWei;
    }
}

/** Thrown when the relayer-quoted fee exceeds the Entrypoint's maxRelayFee for the asset. */
export class RelayFeeExceedsMax extends PoolSessionTransactBaseError implements WithErrorAmounts {
    /**
     * The fee is taken out of the note being withdrawn and the cap is configured
     * per that same asset, so both are `spent`. On a swap or reshield this is NOT
     * the output token the user picked, which is the one they are looking at.
     */
    readonly amounts: ErrorAmounts;

    constructor(feeAmount: string, maxRelayFee: string) {
        super(
            `Relayer fee ${feeAmount} exceeds the Entrypoint maxRelayFee ${maxRelayFee} — execution would revert`,
        );
        this.name = "RelayFeeExceedsMax";
        this.amounts = {
            code: "relayFeeExceedsMax",
            side: "spent",
            values: { fee: BigInt(feeAmount), maxRelayFee: BigInt(maxRelayFee) },
        };
    }
}

/** Thrown when the LiFi quote routes different tokens/chains than requested. */
export class SwapQuoteMismatch extends PoolSessionTransactBaseError {
    constructor(field: string, expected: string, actual: string) {
        super(`LiFi quote ${field} mismatch: expected ${expected}, got ${actual}`);
        this.name = "SwapQuoteMismatch";
    }
}

/** Thrown when a reshield deposit target is not the session's Entrypoint. */
export class DepositTargetMismatch extends PoolSessionTransactBaseError {
    constructor(actual: string, expected: string) {
        super(
            `Reshield depositResult.to ${actual} is not the session Entrypoint ${expected} — funds would be delivered to a non-pool contract`,
        );
        this.name = "DepositTargetMismatch";
    }
}

/** Thrown when `toChainId`/`toChainType` does not match this session's configured destination. */
export class DestinationChainNotSupported extends PoolSessionTransactBaseError {
    constructor(toChainId: number, toChainType: string) {
        super(`Destination chain ${toChainType}:${toChainId} does not match the configured destination`);
        this.name = "DestinationChainNotSupported";
    }
}

/**
 * Thrown by the cross-chain reshield, before quoting, when the destination chain's relayer
 * publishes `destinationCallsSupported: false`: no bridge can run the deposit call there (no
 * LI.FI receivers), so the bridged funds would land on the fallback address instead of the pool.
 */
export class DestinationCallsUnsupported extends PoolSessionTransactBaseError {
    readonly toChainId: number;
    readonly toChainType: string;

    constructor(toChainId: number, toChainType: string) {
        super(
            `Chain ${toChainType}:${toChainId} cannot receive a cross-chain deposit (no bridge can run the destination call there). Choose another destination chain.`,
        );
        this.name = "DestinationCallsUnsupported";
        this.toChainId = toChainId;
        this.toChainType = toChainType;
    }
}

/** Thrown when a cross-chain reshield deposit target is not the destination chain's Entrypoint. */
export class DestinationDepositTargetMismatch extends PoolSessionTransactBaseError {
    constructor(actual: string, expected: string, toChainId: number) {
        super(
            `Reshield-crosschain depositResult.to ${actual} is not chain ${toChainId}'s Entrypoint ${expected} — funds would be delivered to a non-pool contract`,
        );
        this.name = "DestinationDepositTargetMismatch";
    }
}

/**
 * Thrown when a caller passes an explicit `dustRecipient` that does not match
 * the relayer's own address while also opting into dust rescue. The relayer
 * must hold the swept leftover itself to fund the rescue deposit — redirecting
 * dust elsewhere while requesting a rescue is a contradictory request.
 */
export class DustRescueRecipientConflict extends PoolSessionTransactBaseError {
    constructor(dustRecipient: string, relayerAddress: string) {
        super(
            `dustRescue was requested but dustRecipient ${dustRecipient} does not match the relayer address ${relayerAddress} — the relayer must hold the leftover to fund the rescue deposit`,
        );
        this.name = "DustRescueRecipientConflict";
    }
}

/**
 * Thrown when a cross-chain reshield's destination deposit cost exceeds the amount
 * the bridge guarantees to deliver (the route's minAmountLD). Without this guard the
 * flow "succeeds" on the source chain but the destination executor cannot afford the
 * deposit and silently delivers the RAW bridged tokens to the fallback address
 * instead of a shielded note. Callers should rebuild the destination deposit with
 * `affordableNoteValue` and retry the prepare.
 */
export class DestinationDepositUnaffordable extends PoolSessionTransactBaseError {
    /** Largest note value (hex) the guaranteed delivery can fund, vetting fee included. */
    readonly affordableNoteValue: Hash;
    /** The route's guaranteed delivery to the destination call (decimal, funding-token units). */
    readonly destBudget: string;
    /** What the refused deposit would have cost (decimal, funding-token units). */
    readonly totalDepositCost: string;

    constructor(totalDepositCost: string, destBudget: string, affordableNoteValue: Hash) {
        super(
            `Destination deposit cost ${totalDepositCost} exceeds the bridge's guaranteed delivery ${destBudget} — ` +
                `the deposit would fail on arrival and the raw tokens would go to the fallback address. ` +
                `Rebuild the destination deposit with noteValue <= ${affordableNoteValue} and re-prepare.`,
        );
        this.name = "DestinationDepositUnaffordable";
        this.affordableNoteValue = affordableNoteValue;
        this.destBudget = destBudget;
        this.totalDepositCost = totalDepositCost;
    }
}

/**
 * Thrown by `prepareReshieldCrosschainQuote` / `prepareSwapAndDeposit` (cross-chain) when the
 * destination deposit is a plain native-coin `Entrypoint.deposit{value}`. LiFi's Executor sends
 * the route's guaranteed delivery (`destinationCallAmount`, its own `toAmountMin`) as
 * `msg.value`, while the Entrypoint requires `msg.value == noteValue + vettingFee` exactly, so
 * the call can never succeed: the bridged tokens would go to the fallback address instead
 * (three production losses on BSC, 2026-09-22/23; reproduced on a fork 2026-09-24). Land as
 * an ERC-20 or a yield share instead, or route native deposits through a payable adapter that
 * accepts `msg.value >= exact` and refunds the surplus (the `PPRouter` native path already
 * does this for its own shares).
 */
export class NativeDestinationDepositUnsupported extends PoolSessionTransactBaseError {
    constructor(outputToken: string, depositMsgValue: string) {
        super(
            `A cross-chain deposit into the native coin (${outputToken}) via Entrypoint.deposit{value} cannot succeed: ` +
                `LiFi sends its own guaranteed delivery as msg.value, never the exact ${depositMsgValue} the proof ` +
                `commits to, and the Entrypoint requires an exact match. Choose an ERC-20 or yield-share output token.`,
        );
        this.name = "NativeDestinationDepositUnsupported";
    }
}

/**
 * Thrown by same-chain `prepareSwapAndDeposit` when a deposit into the plain native coin cannot be
 * built as one executor transaction (swap, then `Entrypoint.deposit{value}` with the exact cost):
 * no swap executor or swap quote provider is configured for the chain, the input is already the
 * native coin, or the swap's guaranteed output does not cover the deposit's cost.
 */
export class NativeSwapDepositUnavailable extends PoolSessionTransactBaseError {
    constructor(outputToken: string, depositMsgValue: string, reason: string) {
        super(`A swap into a native-coin deposit (${outputToken}, ${depositMsgValue}) cannot be built: ${reason}.`);
        this.name = "NativeSwapDepositUnavailable";
    }
}
