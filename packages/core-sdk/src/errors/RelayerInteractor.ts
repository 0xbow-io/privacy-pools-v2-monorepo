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
