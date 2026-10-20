import type { Hex } from "../internal.js";

/**
 * Status of a swap transaction. `INVALID` is LiFi's own verdict for an unrecognized or
 * expired transfer — unlike `NOT_FOUND` (which may still resolve once indexing catches
 * up), it is unambiguously terminal the moment LiFi returns it, and unlike `FAILED` it is
 * not a bridge failure with a substatus. Kept as its own value rather than folded into
 * either, so a caller can tell "give this more time" from "this is dead, stop waiting".
 */
export type SwapStatus = "NOT_FOUND" | "PENDING" | "DONE" | "FAILED" | "INVALID";

/** Substatus providing more detail on the current swap state. */
export type SwapSubstatus =
    | "WAIT_SOURCE_CONFIRMATIONS"
    | "WAIT_DESTINATION_TRANSACTION"
    | "BRIDGE_NOT_AVAILABLE"
    | "CHAIN_NOT_AVAILABLE"
    | "REFUND_IN_PROGRESS"
    | "COMPLETED"
    | "PARTIAL"
    | "REFUNDED"
    | "UNKNOWN_ERROR";

/** Parameters for requesting swap transaction status. */
export interface SwapStatusRequest {
    /** Source chain transaction hash. */
    txHash: Hex;
    /** Source chain ID. */
    fromChainId: number;
    /** Destination chain ID. */
    toChainId: number;
    /** Bridge tool identifier (e.g. "stargateV2"). Speeds up cross-chain lookup. */
    bridge?: string;
}

/** Result of a swap status query. */
export interface SwapStatusResult {
    /** Top-level status. */
    status: SwapStatus;
    /** Detailed substatus (e.g. "WAIT_DESTINATION_TRANSACTION"). */
    substatus?: SwapSubstatus;
    /** Human-readable substatus message from the bridge. */
    substatusMessage?: string;
    /** Sending (source chain) transaction info. */
    sending?: SwapTransactionInfo;
    /** Receiving (destination chain) transaction info. Present when bridge delivers. */
    receiving?: SwapTransactionInfo;
    /** Link to aggregator explorer for this transfer. */
    explorerLink?: string;
}

/** Transaction info for one leg of a swap (sending or receiving). */
export interface SwapTransactionInfo {
    /** Transaction hash on this chain. */
    txHash?: Hex;
    /** Chain ID. */
    chainId: number;
    /** Block explorer link. */
    txLink?: string;
    /** Token amount transferred (wei string). */
    amount?: string;
    /** USD value (informational). */
    amountUSD?: string;
}
