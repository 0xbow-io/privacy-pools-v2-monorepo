export class SwapQuoteProviderBaseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SwapQuoteProviderBaseError";
    }
}

export class SwapQuoteFailed extends SwapQuoteProviderBaseError {
    constructor(message: string) {
        super(message);
        this.name = "SwapQuoteFailed";
    }
}

export class SwapStatusFailed extends SwapQuoteProviderBaseError {
    /** True for a transient failure worth retrying next sweep (429/5xx, a plain
     * not-yet-indexed 404, or a network-level error) rather than one a caller should
     * treat as permanent. */
    readonly retryable: boolean;

    constructor(message: string, retryable = false) {
        super(message);
        this.name = "SwapStatusFailed";
        this.retryable = retryable;
    }
}

export class UnallowedLiFiAddress extends SwapQuoteProviderBaseError {
    constructor(address: string, role: string, chainId: number) {
        super(
            `LiFi quote ${role} "${address}" is not in RelaySwaps.approvedRouters ` +
                `for chain ${chainId}. This may indicate a compromised quote source. ` +
                `If this is a new router, add it via RelaySwaps.approveRouter().`,
        );
        this.name = "UnallowedLiFiAddress";
    }
}

export class RelaySwapsLayoutMismatch extends SwapQuoteProviderBaseError {
    constructor(relaySwapsAddress: string, expected: string, actual: string, chainId: number) {
        super(
            `RelaySwaps at ${relaySwapsAddress} on chain ${chainId} reports ROUTING_TYPEHASH ` +
                `${actual}, but this SDK build encodes SwapRouting for ${expected}. The deployed ` +
                `contract and this client disagree on SwapRouting's shape (RC-32) — proving now ` +
                `would spend a proof on a call that panics mid-decode. Confirm which RelaySwaps ` +
                `deployment is current for this chain before retrying.`,
        );
        this.name = "RelaySwapsLayoutMismatch";
    }
}

export class LiFiDepositCalldataNotFound extends SwapQuoteProviderBaseError {
    constructor(chainId: number) {
        super(
            `LiFi transactionData does not contain the deposit proof calldata verbatim ` +
                `(chain ${chainId}). A compromised quote source may have replaced the ` +
                `Entrypoint.deposit() call with attacker-controlled calldata. ` +
                `Reject this quote and request a new one.`,
        );
        this.name = "LiFiDepositCalldataNotFound";
    }
}

export class LiFiDepositTargetNotFound extends SwapQuoteProviderBaseError {
    constructor(expectedAddress: string, chainId: number) {
        super(
            `LiFi transactionData does not contain the expected Entrypoint address ` +
                `${expectedAddress} (ABI-padded as a 32-byte word) on chain ${chainId}. ` +
                `The swap may route output to a contract other than the pool. ` +
                `Reject this quote and request a new one.`,
        );
        this.name = "LiFiDepositTargetNotFound";
    }
}

export class LiFiRecipientNotFound extends SwapQuoteProviderBaseError {
    constructor(expected: string, actual: string, chainId: number) {
        super(
            `LiFi transactionData routes swap output to ${actual} ` +
                `instead of the expected recipient ${expected} on chain ${chainId}. ` +
                `The quote may have been tampered with. Reject it and request a new one.`,
        );
        this.name = "LiFiRecipientNotFound";
    }
}

/**
 * No swap route can deliver what a reshield's deposit needs: the aggregator refused to quote the
 * exact-output swap the transaction is built from (e.g. LiFi "Unable to find quote to match
 * expected output"), or no deposit size fits the withdrawal's net budget. Thrown by
 * `estimateReshieldAmount` so the caller can show it at review, before any proof or relayer
 * commitment.
 */
export class SwapRouteUnavailable extends SwapQuoteProviderBaseError {
    constructor(
        readonly fromToken: string,
        readonly toToken: string,
        readonly chainId: number,
        readonly reason: string,
    ) {
        super(`No swap route from ${fromToken} to ${toToken} on chain ${chainId}: ${reason}`);
        this.name = "SwapRouteUnavailable";
    }
}
