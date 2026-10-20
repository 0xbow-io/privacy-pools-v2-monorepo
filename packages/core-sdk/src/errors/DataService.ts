export class DataServiceBaseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DataServiceBaseError";
    }
}

export class InvalidTxHash extends DataServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidTxHash";
    }
}

export class GetBlockNumberFailed extends DataServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "GetBlockNumberFailed";
    }
}

export class WaitForTransactionFailed extends DataServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "WaitForTransactionFailed";
    }
}
