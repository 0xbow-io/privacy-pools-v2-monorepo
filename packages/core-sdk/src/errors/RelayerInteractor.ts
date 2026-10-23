export class RelayerInteractorBaseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RelayerInteractorBaseError";
    }
}

export class InvalidRelayerConfig extends RelayerInteractorBaseError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidRelayerConfig";
    }
}

export class RelayerRequestFailed extends RelayerInteractorBaseError {
    constructor(message: string) {
        super(message);
        this.name = "RelayerRequestFailed";
    }
}

export class RelayerRejected extends RelayerInteractorBaseError {
    constructor(message: string) {
        super(message);
        this.name = "RelayerRejected";
    }
}

export class FeeCommitmentExpired extends RelayerInteractorBaseError {
    constructor(message: string) {
        super(message);
        this.name = "FeeCommitmentExpired";
    }
}

/** A relayer returned HTTP 5xx while pricing, before any relay submission. */
export class RelayerQuoteUnavailable extends RelayerRequestFailed {
    readonly status: number;
    override readonly cause: unknown;

    constructor(status: number, cause: unknown) {
        super("Your funds are safe. The relayer is having issues. Try again later.");
        this.name = "RelayerQuoteUnavailable";
        this.status = status;
        this.cause = cause;
    }
}
