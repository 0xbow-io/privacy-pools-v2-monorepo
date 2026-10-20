/** Base error class for all HashService-related errors. */
export class HashServiceBaseError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "HashServiceBaseError";
    }
}

export class InvalidHashInputs extends HashServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidHashInputs";
    }
}

export class FailedToHashInputs extends HashServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "FailedToHashInputs";
    }
}

export class HashServiceNotInitialized extends HashServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "HashServiceNotInitialized";
    }
}

export class FailedToInitializePoseidon extends HashServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "FailedToInitializePoseidon";
    }
}
