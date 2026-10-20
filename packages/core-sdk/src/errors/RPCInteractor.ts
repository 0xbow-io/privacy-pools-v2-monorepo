/** Base error class for all RPCInteractor-related errors. */
export class RPCInteractorBaseError extends Error {
    /**
     * @param reason - Short description of the error.
     * @param options - Standard `ErrorOptions` (e.g. `cause`) for forwarding.
     */
    constructor(reason: string, options?: ErrorOptions) {
        super(reason, options);
        this.name = "RPCInteractorBaseError";
    }
}

/** Thrown when a readContract call fails (wraps underlying RPC error). */
export class ContractReadError extends RPCInteractorBaseError {
    /**
     * @param reason - Short description (e.g. "execution reverted").
     * @param cause - Optional underlying error preserved on `.cause` to distinguish on-chain reverts from transport failures.
     */
    constructor(reason: string, cause?: unknown) {
        super(`Contract read failed: ${reason}`, { cause });
        this.name = "ContractReadError";
    }
}

/** Thrown when the RPC URL is malformed or uses an unsupported protocol. */
export class InvalidRpcUrl extends RPCInteractorBaseError {
    constructor(reason: string) {
        super(`Invalid RPC URL: ${reason}`);
        this.name = "InvalidRpcUrl";
    }
}

/**
 * Thrown when the ViemRPCInteractor constructor config is invalid (e.g. a
 * non-positive `chunkSize` that would deadlock `getLogsPaginated`).
 */
export class InvalidViemRPCInteractorConfig extends RPCInteractorBaseError {
    constructor(reason: string) {
        super(`Invalid ViemRPCInteractor config: ${reason}`);
        this.name = "InvalidViemRPCInteractorConfig";
    }
}

/** Thrown when the chain config is invalid or unsupported. */
export class InvalidChain extends RPCInteractorBaseError {
    constructor(reason: string) {
        super(`Invalid chain config: ${reason}`);
        this.name = "InvalidChain";
    }
}

/** Thrown when a contract address is not a valid Ethereum address. */
export class InvalidContractAddress extends RPCInteractorBaseError {
    constructor(reason: string) {
        super(`Invalid contract address: ${reason}`);
        this.name = "InvalidContractAddress";
    }
}

/** Thrown when the function name is not found in the provided ABI. */
export class InvalidABIFunctionName extends RPCInteractorBaseError {
    constructor(reason: string) {
        super(`Invalid ABI function name: ${reason}`);
        this.name = "InvalidABIFunctionName";
    }
}

/** Thrown when getBlockNumber fails. */
export class GetBlockNumberError extends RPCInteractorBaseError {
    constructor(reason: string) {
        super(`Get block number failed: ${reason}`);
        this.name = "GetBlockNumberError";
    }
}

/** Thrown when waitForTransactionReceipt fails. */
export class WaitForReceiptError extends RPCInteractorBaseError {
    constructor(reason: string) {
        super(`Wait for receipt failed: ${reason}`);
        this.name = "WaitForReceiptError";
    }
}

/** Thrown when fetching event logs fails (wraps underlying RPC error). */
export class EventReadError extends RPCInteractorBaseError {
    /**
     * @param reason - Short description (e.g. "query returned too many results").
     * @param cause - Optional underlying error preserved on `.cause` so callers
     *   can `instanceof`-check the upstream viem error class (e.g. distinguish
     *   `LimitExceededRpcError` from a generic transport failure).
     */
    constructor(reason: string, cause?: unknown) {
        super(`Event log fetch failed: ${reason}`, { cause });
        this.name = "EventReadError";
    }
}
